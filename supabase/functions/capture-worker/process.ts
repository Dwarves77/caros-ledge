// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 222-256)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 259-581)
// Ported from old_repo/supabase/functions/capture-worker/index.ts (lines 589-614)
// The capture contract, in six clauses (ADR-016, R2c):
//   1. A capture is the FULL decoded body of one document, fetched through the shared policy (src/core/fetch/policy.ts) under the one declared identity and the robots.txt of its host, with every transform declared on the run.
//   2. A non-200, an unsupported type, an error page, a thin body or an unreadable PDF is a recorded failure and is never stored as a capture (INV-184). A paywalled source, and a source on a host the licence register bars (src/core/fetch/licence-hosts.ts), is refused at capture, before any request.
//   3. The queue claim is atomic and one open row exists per source; a transient outcome requeues up to MAX_ATTEMPTS and only a permanent one terminalises (INV-185).
//   4. The only ceiling is the pathological-page sanity bound STORAGE_MAX_CHARS, and binding it is LOUD: a declared transform and a coverage_gap flag, never a quiet trim.
//   5. Every outcome is read back: a failed claim, idempotency read or write is reported and requeues, never read as "already claimed" or "no duplicate". Idempotency is (final URL, content hash).
//   6. A wall (403, 429, a challenge page, the EUR-Lex 202 gate, a robots.txt disallow) is final for this transport and never retried as another identity: the row is left `refused` for the browser tier on the Actions runner, which
//      owns the rest of the ladder (browser, substitute publisher, access request). A robots.txt that cannot be read defers the row, never denies it.
import { guardedFetch, makeHostGate, makeRobotsReader } from "../../../src/core/fetch/guard.ts";
import { licenceForbidsHost } from "../../../src/core/fetch/licence-hosts.ts";
import { BOT_USER_AGENT, captureLocale, fetchDocument, isWallStatus, MAX_ATTEMPTS, storageMaxChars, type FetchOutcome } from "../../../src/core/fetch/policy.ts";
import { makeRobotsGate } from "../../../src/core/fetch/robots.ts";
import { storeCapture, type CaptureChannel, type Db, type Query, type Reply } from "../../../src/core/fetch/store-capture.ts";

export type { Db, Query, Reply };
export interface QueueRow {
  id: string;
  source_id: string;
  status: string;
  attempt_count: number;
}
export interface WorkerDeps {
  db: Db;
  /** The raw network fetch (absent: the global one). Every request is wrapped by the guard, so a test's fake sits under the same identity, address check and robots.txt as production. */
  fetchImpl?: typeof fetch;
  extractPdf?: (bytes: Uint8Array) => Promise<{ text: string; pages: number | null; title: string | null }>;
  env: Record<string, string | undefined>;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  resolveHost?: (host: string) => Promise<string[]>;
}
export interface ChannelAttempt {
  channel: CaptureChannel;
  url: string;
  status: number | null;
  reason: string | null;
  detail: string | null;
}
export interface CaptureReport {
  queue_id: string;
  source_id: string;
  outcome: "captured" | "unchanged" | "requeued" | "refused" | "deferred" | "failed" | "skipped";
  http_status: number | null;
  chars: number | null;
  capture_id: string | null;
  run_id: string | null;
  intelligence_item_id: string | null;
  content_type: string | null;
  nulls_removed: number;
  pdf_pages: number | null;
  pdf_bytes: number | null;
  detail: string | null;
  url: string | null;
  channel: CaptureChannel | null;
  attempts: ChannelAttempt[];
  storage_ceiling_bind?: { collected: number; fullLength: number };
}

/** A service-role bearer is the only caller: the function is invoked by the dispatcher or the capture_worker_fetch rpc with the service key. Compared in constant time. */
export function isServiceRoleRequest(authorization: string | null, serviceKey: string | undefined): boolean {
  if (!serviceKey || !authorization?.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(authorization.slice(7));
  const b = new TextEncoder().encode(serviceKey);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const err = (r: { error: { message: string } | null }) => (r.error ? r.error.message : null);
/** The host name of a URL ("" when it does not parse): the register names hosts, not URLs. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

interface Kit {
  page: typeof fetch;
  api: typeof fetch;
}
const kits = new WeakMap<object, Kit>();
/** The two guarded GETs of a drain: pages (robots.txt honoured) and a publisher's documented API (identity, address check and gap, no robots check). One robots cache and one host gate for the drain. */
function kitOf(deps: WorkerDeps): Kit {
  const held = kits.get(deps);
  if (held) return held;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = { licence: licenceForbidsHost, userAgent: BOT_USER_AGENT, fetchImpl: deps.fetchImpl ?? fetch, gate: makeHostGate({ now: deps.now, sleep }), upgradeHttp: true, ...(deps.resolveHost ? { resolveHost: deps.resolveHost } : {}) };
  const robots = makeRobotsGate(makeRobotsReader(base));
  const kit: Kit = { page: (u, i) => guardedFetch(String(u), i ?? {}, { ...base, robots }), api: (u, i) => guardedFetch(String(u), i ?? {}, base) };
  kits.set(deps, kit);
  return kit;
}

async function record(deps: WorkerDeps, table: string, op: "insert" | "update", payload: Record<string, unknown>, eq?: [string, unknown]): Promise<string | null> {
  const q = deps.db.from(table);
  const base = op === "insert" ? q.insert(payload) : q.update(payload);
  return err(await (eq ? base.eq(eq[0], eq[1]) : base));
}
/** The source's collection state and the attempt record behind it (migration 0080); a failed write is reported on the row's detail. */
async function setSourceState(deps: WorkerDeps, report: CaptureReport, state: "served" | "deferred" | "robots_disallowed" | "refused", extra: Record<string, unknown> = {}): Promise<void> {
  const e = await record(deps, "sources", "update", { collection_state: state, collection_detail: { at: new Date(deps.now()).toISOString(), attempts: report.attempts, ...extra } }, ["id", report.source_id]);
  if (e) report.detail = `${report.detail}; source state write failed: ${e}`;
}
/** Requeue a TRANSIENT failure (status stays queued so the one-open-row index never wedges the source). No agent_runs row: a retry is not a capture outcome. */
async function recordRetry(deps: WorkerDeps, row: QueueRow, report: CaptureReport): Promise<void> {
  const e = await record(deps, "pending_first_fetch", "update", { status: "queued", last_error_text: `[transient, will retry] ${report.detail}` }, ["id", row.id]);
  report.outcome = "requeued";
  if (e) report.detail = `${report.detail}; requeue write failed: ${e}`;
}
async function recordFailure(deps: WorkerDeps, row: QueueRow, src: { id: string; url: string | null }, report: CaptureReport, runStart: number): Promise<void> {
  const at = new Date(deps.now()).toISOString();
  const e1 = await record(deps, "agent_runs", "insert", { source_id: src.id, source_url: src.url, fetch_method: "capture-worker", status: "error", fetch_status: report.http_status, ended_at: at, duration_ms: deps.now() - runStart, errors: [{ detail: report.detail, content_type: report.content_type, at }] });
  const e2 = await record(deps, "pending_first_fetch", "update", { status: "error", last_error_text: report.detail }, ["id", row.id]);
  report.outcome = "failed";
  const writeErr = [e1 && `agent_runs: ${e1}`, e2 && `queue: ${e2}`].filter(Boolean).join("; ");
  if (writeErr) report.detail = `${report.detail}; failure record incomplete (${writeErr})`;
}

/** A wall: the host declined this transport. 401, 403 and 429 (on the page or on robots.txt itself), a challenge page that passed the status check, EUR-Lex's 202 gate and a robots.txt disallow are final here; the browser tier or a substitute owns what follows. */
export const isWall = (d: Extract<FetchOutcome, { ok: false }>): boolean => d.reason === "robots_disallowed" || (d.reason === "robots_unknown" && d.identityRefused === true) || d.reason === "error_marker" || (d.reason === "non_200" && (isWallStatus(d.status) || d.status === 202));
/** A deferral: robots.txt could not be read, or the host asked for a longer gap than a drain sleeps. Tried again, never denied. */
export const isDeferral = (d: Extract<FetchOutcome, { ok: false }>): boolean => d.reason === "robots_unknown" || d.reason === "host_busy";

/** Process one queue row end to end under the contract above. Never throws: every outcome is on the report. */
export async function processRow(deps: WorkerDeps, row: QueueRow): Promise<CaptureReport> {
  const { db } = deps;
  const report: CaptureReport = { queue_id: row.id, source_id: row.source_id, outcome: "failed", http_status: null, chars: null, capture_id: null, run_id: null, intelligence_item_id: null, content_type: null, nulls_removed: 0, pdf_pages: null, pdf_bytes: null, detail: null, url: null, channel: null, attempts: [] };
  const srcRes = await db.from("sources").select("id, url, name, paywalled, access_method, api_endpoint_url, rss_feed_url, publisher_locale").eq("id", row.source_id).single();
  const src = srcRes.data as { id: string; url: string; name: string; paywalled: boolean | null; access_method: string | null; api_endpoint_url: string | null; rss_feed_url: string | null; publisher_locale: string | null } | null;
  if (srcRes.error || !src?.url) {
    report.detail = srcRes.error ? `source read failed: ${srcRes.error.message}` : "source row or url missing";
    await recordFailure(deps, row, { id: row.source_id, url: null }, report, deps.now());
    return report;
  }
  report.url = src.url;
  if (src.paywalled) {
    report.detail = "paywalled: the source is flagged paywalled and is refused at capture, before any request";
    await recordFailure(deps, row, src, report, deps.now());
    return report;
  }

  // The licence register binds the worker as it binds every fetch: a publisher whose terms bar automated access is refused before any request, and the refusal is recorded with the register key.
  const barred = licenceForbidsHost(hostOf(src.url));
  if (barred) {
    report.attempts.push({ channel: "direct", url: src.url, status: null, reason: "licence_forbids", detail: `the licence register (${barred}) bars collecting from this host` });
    report.detail = `licence_forbids [${barred}]: the licence register bars collecting from this host; refused at capture, before any request`;
    await recordFailure(deps, row, src, report, deps.now());
    return report;
  }

  // Item scoping: exactly one live item on the source links the capture, else it is pool-scoped. A read error requeues; scope is never guessed.
  const itemsRes = await db.from("intelligence_items").select("id").eq("source_id", src.id).eq("is_archived", false).limit(50);
  if (itemsRes.error) {
    report.detail = `item-scope read failed: ${itemsRes.error.message}`;
    await recordRetry(deps, row, report);
    return report;
  }
  const items = (itemsRes.data as Array<{ id: string }> | null) ?? [];
  const itemId = items.length === 1 ? (items[0]?.id ?? null) : null;
  report.intelligence_item_id = itemId;

  // Atomic claim: queued or error to fetching only if this call wins the row. A claim error is reported; it is never read as "already claimed".
  const claimRes = await db.from("pending_first_fetch").update({ attempt_count: row.attempt_count + 1, last_attempt_at: new Date(deps.now()).toISOString(), status: "fetching" }).eq("id", row.id).in("status", ["queued", "error"]).select("id");
  if (claimRes.error) {
    report.outcome = "failed";
    report.detail = `claim write failed: ${claimRes.error.message}`;
    return report;
  }
  const claimed = claimRes.data as unknown[] | null;
  if (!claimed || claimed.length === 0) {
    report.outcome = "skipped";
    report.detail = "row already claimed by another run";
    return report;
  }
  const attempt = row.attempt_count + 1;
  const runStart = deps.now();
  const ceiling = storageMaxChars(deps.env);
  const kit = kitOf(deps);

  // The channels in order: a source with a registered API, or whose access method is api or rss, reads its declared channels first (APIs are preferred wherever a publisher offers one); every other source reads its page first and its registered feed after a refusal. The page is the direct channel.
  const declared: Array<{ channel: "api" | "feed"; url: string }> = [...(src.api_endpoint_url ? [{ channel: "api" as const, url: src.api_endpoint_url }] : []), ...(src.rss_feed_url ? [{ channel: "feed" as const, url: src.rss_feed_url }] : [])];
  const direct = { channel: "direct" as const, url: src.url };
  const declaredFirst = !!src.api_endpoint_url || src.access_method === "api" || src.access_method === "rss";
  const order = declaredFirst ? [...declared, direct] : [direct, ...declared];
  let doc: Extract<FetchOutcome, { ok: true }> | null = null;
  let won: CaptureChannel | null = null;
  let page: Extract<FetchOutcome, { ok: false }> | null = null;
  let last: Extract<FetchOutcome, { ok: false }> | null = null;
  for (const step of order) {
    const out = await fetchDocument(step.url, { fetchImpl: step.channel === "api" ? kit.api : kit.page, ...(deps.extractPdf ? { extractPdf: deps.extractPdf } : {}), now: deps.now, maxChars: ceiling });
    report.attempts.push({ channel: step.channel, url: step.url, status: out.ok ? out.status : out.status, reason: out.ok ? null : out.reason, detail: out.ok ? null : out.detail });
    if (out.ok) {
      doc = out;
      won = step.channel;
      break;
    }
    last = out;
    if (step.channel === "direct") page = out;
  }
  if (!doc || !won) {
    const d = page ?? (last as Extract<FetchOutcome, { ok: false }>);
    report.http_status = d.status;
    report.content_type = d.contentType;
    report.pdf_bytes = d.pdfBytes;
    report.detail = d.detail;
    if (isWall(d)) {
      const robots = d.reason === "robots_disallowed";
      report.outcome = "refused";
      const e = await record(deps, "pending_first_fetch", "update", { status: "refused", last_error_text: `[${robots ? "robots_disallowed" : "refused"}] ${d.detail}` }, ["id", row.id]);
      if (e) report.detail = `${report.detail}; queue write failed: ${e}`;
      await setSourceState(deps, report, robots ? "robots_disallowed" : "refused", robots && d.rule ? { robots_rule: d.rule } : {});
    } else if (isDeferral(d)) {
      await setSourceState(deps, report, "deferred");
      if (attempt < MAX_ATTEMPTS) {
        await recordRetry(deps, row, report);
        report.outcome = "deferred";
      } else await recordFailure(deps, row, src, report, runStart);
    } else if (d.transient && attempt < MAX_ATTEMPTS) await recordRetry(deps, row, report);
    else await recordFailure(deps, row, src, report, runStart);
    return report;
  }
  report.http_status = doc.status;
  report.content_type = doc.contentType;
  report.chars = doc.text.length;
  report.nulls_removed = doc.nullsRemoved;
  report.pdf_pages = doc.pdfPages;
  report.pdf_bytes = doc.pdfBytes;
  report.channel = won;

  const bind = doc.ceilingBind;
  if (bind) report.storage_ceiling_bind = bind;
  const stored = await storeCapture(db, { sourceId: src.id, sourceUrl: src.url, sourceName: src.name, finalUrl: doc.finalUrl, text: doc.text, title: doc.title, httpStatus: doc.status, channel: won, numberLocale: captureLocale(src.publisher_locale, doc.language), itemId, itemIds: items.map((i) => i.id), declaredTransforms: doc.declaredTransforms, ceilingBind: bind, ceiling }, deps.now, runStart);
  report.capture_id = stored.captureId;
  report.run_id = stored.runId;
  if (stored.outcome === "failed") {
    report.detail = stored.detail;
    await recordRetry(deps, row, report);
    return report;
  }
  const done = await record(deps, "pending_first_fetch", "update", { status: "done", last_error_text: stored.outcome === "unchanged" ? "[unchanged] the body is identical to the stored capture" : null }, ["id", row.id]);
  report.outcome = stored.outcome;
  report.detail = stored.outcome === "unchanged" ? stored.detail : `${doc.isPdf ? `pdf text layer stored (${doc.pdfPages} pages, declared transform)` : "stored verbatim"}, ${itemId ? "item-linked" : "pool-scoped"}, channel ${won}${stored.detail ? `; ${stored.detail}` : ""}`;
  if (done) report.detail = `${report.detail}; queue write failed: ${done}`;
  await setSourceState(deps, report, "served", { channel: won, content_hash: stored.contentHash });
  return report;
}

/** The queue select and the loop: the default drain takes queued rows only; an explicit replay may also take a row at 'error'. A queue read failure is a 500, never an empty drain. */
export async function drain(deps: WorkerDeps, input: { limit?: number; queue_ids?: string[] | null }): Promise<{ status: number; body: Record<string, unknown> }> {
  const limit = Math.min(Number(input.limit ?? 3), 10);
  const ids = Array.isArray(input.queue_ids) ? input.queue_ids : null;
  const base = deps.db.from("pending_first_fetch").select("id, source_id, status, attempt_count");
  const q = ids ? base.in("id", ids) : base.eq("status", "queued").order("queued_at").limit(limit);
  const { data, error } = await q;
  if (error) return { status: 500, body: { error: error.message } };
  const results: Array<CaptureReport | { queue_id: string; outcome: string; detail: string }> = [];
  for (const row of (data ?? []) as QueueRow[]) {
    if (row.status !== "queued" && !(ids && row.status === "error")) {
      results.push({ queue_id: row.id, outcome: "skipped", detail: `status=${row.status}, not queued` });
      continue;
    }
    results.push(await processRow(deps, row));
  }
  return { status: 200, body: { processed: results.length, results } };
}
