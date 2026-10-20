// New in R2c: no old counterpart (the old tree retried a 403 as another browser and had no browser tier, no substitute publisher and no access request; D:49, the collection-under-honest-identity measurement).
// The runner side of the collection ladder. The capture worker (an Edge Function with no browser) leaves a walled source `refused`; this runtime takes those rows and finishes the ladder: the browser tier (headless Chromium on the
// Actions runner, a real browser identity, robots.txt honoured, never solving a CAPTCHA, human pace), then the same instrument at another official publisher by identifier (registered and rated through registerAndRate, the capture
// belongs to that publisher's row), and only when every channel has been tried and refused, an access request with the contact the publisher publishes. No archive, cache or proxy is ever read.
import { toText } from "@/core/fetch/classify-body";
import { extractPdfText } from "@/core/fetch/direct";
import { closeBrowser, fetchBrowser, type BrowserDeps } from "@/core/fetch/headless";
import { fetchAllowed } from "@/core/fetch/hold";
import { honestFetch, robotsGateFor } from "@/core/fetch/honest";
import { escalateFetch, type SubstituteHit, type TransportName } from "@/core/fetch/ladder";
import { licenceForbidsHost } from "@/core/fetch/licence-hosts";
import { captureLocale, fetchDocument, storageMaxChars } from "@/core/fetch/policy";
import { storeCapture, type CaptureChannel, type Db as StoreDb } from "@/core/fetch/store-capture";
import { hostOf } from "@/core/shared";
import { identifiersOf, substituteCandidates } from "@/core/sources/publishers";
import { registerAndRate } from "@/core/sources/register";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";

const COLLECT_MAX_LIMIT = 10;
export interface CollectDeps extends RunDeps, Omit<BrowserDeps, "now" | "db"> {}
interface QueueRow {
  id: string;
  source_id: string;
  attempt_count: number;
}
interface SourceRow {
  id: string;
  url: string;
  name: string;
  paywalled: boolean | null;
  access_method: string | null;
  api_endpoint_url: string | null;
  rss_feed_url: string | null;
  sitemap_url: string | null;
  publisher_locale: string | null;
}

/**
 * Finish the ladder for every `refused` queue row (up to `limit`): browser tier, substitute publisher, access request. Counts: served (browser), substituted, access_requested, deferred (the browser is not available here, or robots.txt
 * could not be read), failed. A dry run reads the rows and fetches nothing. Called by the check-sources worker route after change detection; it closes the browser it opened.
 */
export async function collectRefused(deps: CollectDeps, input: { limit?: number; dry?: boolean } = {}): Promise<RunResult> {
  const { db } = deps;
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 3)), COLLECT_MAX_LIMIT);
  const queue = await db.from("pending_first_fetch").select("id, source_id, attempt_count").eq("status", "refused").order("queued_at", { ascending: true }).limit(limit);
  if (queue.error) return { counts: {}, outcome: "failed", notes: [`refused-queue read failed: ${queue.error.message}`] };
  const rows = (queue.data ?? []) as QueueRow[];
  const counts = { refused: rows.length, served: 0, substituted: 0, access_requested: 0, deferred: 0, failed: 0 };
  const notes: string[] = [];
  if (input.dry || rows.length === 0) return { counts, outcome: "ok", notes: input.dry ? ["dry: nothing fetched, nothing written"] : [] };
  const gate = await fetchAllowed("https://gate.invalid/", deps.caller, deps);
  if (!gate.allowed) return { counts: { ...counts, deferred: rows.length }, outcome: "failed", notes: [`fetch gate closed (${gate.reason}): the refused rows are not touched`] };
  const today = deps.now().toISOString().slice(0, 10);
  const env = (deps.env ?? {}) as Record<string, string | undefined>;
  try {
    for (const row of rows) {
      const claim = await db.from("pending_first_fetch").update({ status: "fetching", last_attempt_at: deps.now().toISOString(), attempt_count: row.attempt_count + 1 }).eq("id", row.id).eq("status", "refused").select("id");
      if (claim.error || !(claim.data as unknown[] | null)?.length) {
        notes.push(`${row.id}: ${claim.error ? `claim failed: ${claim.error.message}` : "already claimed"}`);
        continue;
      }
      const started = deps.now().getTime();
      const park = (status: "refused" | "error" | "skipped" | "done", text: string | null) => db.from("pending_first_fetch").update({ status, last_error_text: text }).eq("id", row.id);
      const srcRes = await db.from("sources").select("id, url, name, paywalled, access_method, api_endpoint_url, rss_feed_url, sitemap_url, publisher_locale").eq("id", row.source_id).single();
      const src = srcRes.data as SourceRow | null;
      if (srcRes.error || !src) {
        counts.failed++;
        notes.push(`${row.id}: source read failed: ${srcRes.error?.message ?? "no row"}`);
        await park("error", "source read failed");
        continue;
      }
      const items = await db.from("intelligence_items").select("id, instrument_identifier").eq("source_id", src.id).eq("is_archived", false).limit(50);
      if (items.error) {
        counts.failed++;
        notes.push(`${row.id}: item read failed: ${items.error.message}`);
        await park("refused", `[retry] item read failed: ${items.error.message}`);
        continue;
      }
      const live = (items.data ?? []) as Array<{ id: string; instrument_identifier: string | null }>;
      const itemId = live.length === 1 ? (live[0]?.id ?? null) : null;
      const ceiling = storageMaxChars(env);
      const ids = identifiersOf(src.url, live.map((i) => i.instrument_identifier).filter(Boolean).join(" "));
      const choices = substituteCandidates(ids, { env, today, refusingHost: hostOf(src.url) });
      const fetchOne = async (url: string, headers: Record<string, string>, api: boolean) => fetchDocument(url, { fetchImpl: honestFetch(deps, { api }), extractPdf: extractPdfText, now: () => deps.now().getTime(), maxChars: ceiling, headers });
      const verdict = await escalateFetch(src.url, {
        source: { api_endpoint_url: src.api_endpoint_url, rss_feed_url: src.rss_feed_url, sitemap_url: src.sitemap_url, access_method: src.access_method, paywalled: !!src.paywalled },
        skip: ["direct", "api", "feed"] as TransportName[],
        max: 10_000_000,
        licence: licenceForbidsHost,
        cacheGet: null,
        apiFetch: null,
        feedFetch: null,
        sitemapProbe: null,
        directFetch: null,
        seekMore: null,
        browserFetch: (url) => fetchBrowser(url, deps, { max: 10_000_000, paywalled: !!src.paywalled }),
        substituteFetch: async (): Promise<SubstituteHit[]> => {
          const hits: SubstituteHit[] = [];
          for (const c of choices.use) {
            const doc = await fetchOne(c.url, c.headers, c.entry.channel === "api");
            if (!doc.ok) {
              hits.push({ url: c.url, host: c.entry.host, publisherId: c.entry.id, result: { status: doc.status ?? 0, text: "", truncated: false, fullLength: 0, cap: 0, refusal: doc } });
              continue;
            }
            const text = toText(doc.text);
            hits.push({ url: doc.finalUrl, host: c.entry.host, publisherId: c.entry.id, result: { status: doc.status, text, html: doc.text, truncated: false, fullLength: text.length, cap: 10_000_000, finalUrl: doc.finalUrl, title: doc.title, language: doc.language } });
            if (text.length > 200) break;
          }
          return hits;
        },
        contactOf: async (url) => {
          const v = await robotsGateFor(deps)(url);
          return { contact: v.contact, rule: v.rule };
        },
      });
      const attemptRecord = verdict.attempts.map((a) => ({ channel: a.transport, url: a.url, status: a.status ?? null, reason: a.reason, detail: a.detail ?? null }));
      const setState = (state: "served" | "deferred" | "robots_disallowed" | "refused" | "access_requested", extra: Record<string, unknown> = {}) =>
        db.from("sources").update({ collection_state: state, collection_detail: { at: deps.now().toISOString(), attempts: attemptRecord, skipped_substitutes: choices.skipped, ...extra }, ...(state === "access_requested" ? { access_requested_at: deps.now().toISOString(), access_contact: verdict.access?.contact ?? null } : {}) }).eq("id", src.id);
      if (verdict.outcome === "content" && verdict.result) {
        const channel: CaptureChannel = verdict.transport === "substitute" ? "substitute" : "browser";
        let ownerId = src.id;
        let ownerUrl = src.url;
        let ownerName = src.name;
        if (channel === "substitute" && verdict.substitute) {
          const rated = await registerAndRate(db, verdict.substitute.url);
          if (!("source_id" in rated)) {
            counts.failed++;
            notes.push(`${row.id}: the substitute publisher ${verdict.substitute.host} could not be registered and rated (${rated.status}: ${rated.reason}); its text is not stored`);
            await park("refused", `[retry] substitute ${verdict.substitute.host} unrated`);
            continue;
          }
          ownerId = rated.source_id;
          ownerUrl = verdict.substitute.url;
          ownerName = verdict.substitute.host;
        }
        const r = verdict.result;
        const stored = await storeCapture(db as unknown as StoreDb, { sourceId: ownerId, sourceUrl: ownerUrl, sourceName: ownerName, finalUrl: r.finalUrl ?? verdict.url ?? src.url, text: r.html ?? r.text, title: r.title ?? null, httpStatus: r.status, channel, numberLocale: captureLocale(channel === "substitute" ? null : src.publisher_locale, r.language), itemId, itemIds: live.map((i) => i.id), declaredTransforms: [{ declared_transform: "collection-channel", channel, at: deps.now().toISOString() }], ceilingBind: null, ceiling }, () => deps.now().getTime(), started);
        if (stored.outcome === "failed") {
          counts.failed++;
          notes.push(`${row.id}: ${stored.detail}`);
          await park("refused", `[retry] ${stored.detail}`);
          continue;
        }
        await park("done", stored.outcome === "unchanged" ? "[unchanged] the body is identical to the stored capture" : null);
        await setState("served", { channel, content_hash: stored.contentHash, ...(verdict.substitute ? { substitute_publisher: verdict.substitute.host, substitute_url: verdict.substitute.url } : {}) });
        if (channel === "substitute") counts.substituted++;
        else counts.served++;
      } else if (verdict.outcome === "access_requested") {
        await setState("access_requested", { cause: verdict.reason, robots_rule: verdict.access?.rule ?? null });
        await park("skipped", `[access_requested] ${verdict.reason ?? "refused"}`);
        counts.access_requested++;
      } else if (verdict.outcome === "deferred") {
        await setState("deferred", { why: verdict.holdReason });
        await park("refused", `[deferred] ${verdict.holdReason ?? "deferred"}`);
        counts.deferred++;
      } else {
        await setState("refused", { outcome: verdict.outcome });
        await park("error", `[${verdict.outcome}] ${verdict.reason ?? "no channel served"}`);
        counts.failed++;
      }
    }
  } finally {
    await closeBrowser(deps);
  }
  return { counts, outcome: outcomeOf(rows.length - counts.deferred, counts.failed), notes };
}
