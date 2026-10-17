// THE adapters: every deps interface a slice declared for a slice that was not merged yet, built here from the real exports of the merged slices (the parallel-build bet,
// proven by tests/turn/wiring-types.test.ts). One construction site: `buildDeps(sb, env, opts)` returns every deps object; `wireAll()` wires the ones the app serves with.
import type { Db } from "@/core/db";
import { fetchAllRows, isServiceConfigured, serviceClient } from "@/core/db";
import { deriveKey } from "@/core/intake/canonical-key";
import type { IdentityHelpers } from "@/core/intake";
import { assertFetchAllowed, capture, classifyBody, detectAccessWall, fetchAllowed, fetchDirect, makePoliteGate, parseOjReference } from "@/core/fetch";
import { isStorableClass } from "@/core/fetch/classify-body";
import { congruence, matchExistingSubject, sourceRole } from "@/core/entities";
import { type Mode, makeRecorder, type RecorderContext } from "@/core/harness";
import { timePhase, withServerTiming } from "@/core/perf";
import { createMethodRegistry, type LearningDeps, type MarketMethodDeps, type MethodRegistry, registerMarketMethods } from "@/core/propagation";
import type { Catalog, ProducerSpec } from "@/core/producers";
import type { ProducerDeps } from "@/core/producers/deps";
import { surfaceHref, surfaceOf } from "@/core/routing";
import { buildResolver, classTierForHost, hostInstitution, institutionKey, loadHostVerdicts, officialnessOf, registerAndRate, verifyPoolTargetMatch, type SourceRow } from "@/core/sources";
import type { HostVerdictRef } from "@/core/sources";
import { hostOf } from "@/core/shared/url";
import { createConnectDeps } from "@/features/flywheel";
import { navCountSources } from "@/features/lists";
import { getNavCounts } from "@/ui/shell/nav-counts.server";
import { setIntakeDepsFactory } from "@/features/intake/api/run";
import type { CaptureResult, IntakeDeps, SourcesDeps } from "@/features/intake/deps";
import { questionFlagRow } from "@/features/learning";
import { carbonIntensity } from "@/features/market/lib/carbon";
import { computeSeriesDeltas } from "@/features/market/lib/deltas";
import { eeaHdvRoadmaps, carrierEtsSurcharge, ecbFx, eiaPetroleumSpot, euOilBulletin, gridQueueRows, oemRoadmapRows, publishedPriceStatistics, rerouteRows, sbtiTargets } from "@/features/market/producers";
import type { MarketSeriesDeps } from "@/features/market/producers/market-series-delta";
import { readSeriesItemMap } from "@/features/market/producers/market-series-items";
import { bindMint, type MintCtx } from "@/features/mint";
import type { EntityDeps, MintRunDeps } from "@/features/mint/deps";
import { auxiliaryEnergyRows, blsOews, eurostatElectricity, eurostatLabourCost, indexationRows, nesoCarbonIntensity, stateCostFacts, ukpnHeatmap } from "@/features/operations/producers";
import { researchAssessment, researchWalker } from "@/features/research";
import type { EdgeAuthors } from "@/features/propagation/ops";
import { holdingsPresent } from "@/features/sources";
import { assistantDeps } from "@/features/assistant/deps";
import { dashboardDeps } from "@/features/dashboard/deps";
import { portfolioDeps } from "@/features/portfolio/deps";
import type { StatutoryDeps } from "@/features/statutory";
import { wireWorkspaceDeps, type WorkspaceDeps } from "@/features/workspace/api/deps";

type Env = Record<string, string | undefined>;
export type CaptureDeps = MintRunDeps["fetch"];

export interface DepsOptions {
  now?: () => Date;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The market slice's arithmetic (P2-11): when absent the market methods are not registered and a market write fails closed. */
  market?: MarketMethodDeps | null;
  /** Host verdicts handed in whole (a test); absent, they are read from host_verdicts by loadReferenceData (IMP-054). */
  verdicts?: ReadonlyMap<string, HostVerdictRef> | null;
  catalog?: Catalog;
  /** The capture worker call; the default invokes the deployed Edge Function through the service client. A test passes the worker's own drain over the fixture client. */
  worker?: CaptureWorker;
  /** The regulations slice's formula (P2-10) and the market slice's edge authors (P2-11): the ops that need them refuse until they are passed. */
  statutory?: StatutoryDeps | null;
  edgeAuthors?: EdgeAuthors | null;
  /** The research-assessment producer spec the propagate stage re-scores with (default: the shipped one, whose reviewed constant holds it off in build mode). */
  assessment?: ProducerSpec;
}
export type CaptureWorker = (input: { limit: number }) => Promise<{ status: number; body: Record<string, unknown> }>;

/** The text and bytes of a URL through the hold gate: nothing here reaches the network while the cadence is off (INV-177). */
export interface Io {
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string): Promise<Uint8Array>;
  fetchJson(url: string): Promise<never>;
}

export interface BuiltDeps {
  sb: Db;
  env: Env;
  now: () => Date;
  /** Published by the run frame; the recorder and the dry-aware adapters read it. */
  context: { current: RecorderContext | null };
  recorder: ReturnType<typeof makeRecorder>;
  gate: { allowed: boolean; refresh(): Promise<boolean> };
  sources: SourcesDeps;
  entities: EntityDeps;
  identity: IdentityHelpers;
  fetch: CaptureDeps;
  io: Io;
  mintCtx: MintCtx;
  intake: IntakeDeps;
  mintRun: MintRunDeps;
  connect: IntakeDeps["connect"];
  producers: ProducerDeps & { market: MarketSeriesDeps | null; mint: MintCtx; verdicts: ReadonlyMap<string, HostVerdictRef> };
  catalog: Catalog;
  worker: CaptureWorker;
  marketMethods: MarketMethodDeps | null;
  statutory: StatutoryDeps | null;
  edgeAuthors: EdgeAuthors | null;
  assessment: ProducerSpec;
  registry: MethodRegistry;
  learning: LearningDeps;
  workspace: Partial<WorkspaceDeps>;
  halted(): Promise<boolean>;
  /** Read the host verdicts (host_verdicts) and the series keys (market_series_items) once; the notes say what degraded (a table absent before the cutover, a failed read). The turn calls it first; the intake rating calls it before it rates. */
  loadReferenceData(): Promise<string[]>;
}

const UA = { "user-agent": "FSI-turn/1.0 (+turn)", accept: "*/*" };
const MAX_BYTES = 50 * 1024 * 1024;

/** The catalog every registry entry is checked against: each producer spec by name. */
export const PRODUCER_CATALOG: Catalog = Object.freeze(Object.fromEntries([eeaHdvRoadmaps, carrierEtsSurcharge, ecbFx, eiaPetroleumSpot, euOilBulletin, gridQueueRows, oemRoadmapRows, publishedPriceStatistics, rerouteRows, sbtiTargets, auxiliaryEnergyRows, blsOews, eurostatElectricity, eurostatLabourCost, indexationRows, nesoCarbonIntensity, stateCostFacts, ukpnHeatmap, researchAssessment, researchWalker].map((s) => [s.name, s])));

const captureFamily = (url: string) => (parseOjReference(url) ? ("oj_issue" as const) : ("generic" as const));

export function buildDeps(sb: Db, env: Env = process.env, opts: DepsOptions = {}): BuiltDeps {
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch: typeof fetch = opts.fetchImpl ?? ((...a) => fetch(...a));
  const context: BuiltDeps["context"] = { current: null };
  const dry = (): boolean => context.current?.mode !== ("apply" satisfies Mode);
  const recorder = makeRecorder(sb, now, () => context.current);
  const hold = { db: sb, env };
  const fetchDeps: CaptureDeps = { db: sb, env, now, fetchImpl: doFetch, throttle: makePoliteGate({ gapMs: 1000, now: () => now().getTime(), sleep }) };

  // The reference data of the turn, read once per deps: host verdicts for rating a host the class table does not place, and the market series keys (the mint's record_hollow exemption). Both are tables (IMP-054, IMP-084).
  const verdicts = new Map<string, HostVerdictRef>(opts.verdicts ?? []);
  const seriesKeys = new Set<string>();
  let reference: Promise<string[]> | null = null;
  const loadReferenceData = (): Promise<string[]> =>
    (reference ??= (async () => {
      const notes: string[] = [];
      if (!opts.verdicts) for (const [host, v] of await loadHostVerdicts(sb, notes)) verdicts.set(host, v);
      try {
        for (const [key] of await readSeriesItemMap(sb)) seriesKeys.add(key);
      } catch (e) {
        notes.push(`no market series key is known this run: ${e instanceof Error ? e.message : String(e)}`);
      }
      return notes;
    })());
  const isSeriesKey = (identifier: string | null | undefined): boolean => !!identifier && seriesKeys.has(identifier);

  let cached: { resolve: (url: string) => { tier: number | null; sourceId: string | null } } | null = null;
  const resolver = async () => {
    if (!cached) {
      const rows = await fetchAllRows<SourceRow>((from, to) => sb.from("sources").select("id, url, base_tier, tier_override, status").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
      cached = { resolve: buildResolver(rows).resolveSpan };
    }
    return cached.resolve;
  };
  const gate = {
    allowed: false,
    async refresh() {
      gate.allowed = (await fetchAllowed("https://gate.invalid/", null, hold)).allowed;
      return gate.allowed;
    },
  };

  const sources: SourcesDeps = {
    async resolveSource(url) {
      const hit = (await resolver())(url);
      return hit.tier === null && hit.sourceId === null ? null : { tier: hit.tier, institution: hostInstitution(hostOf(url)) || null, sourceId: hit.sourceId };
    },
    async registerAndRate(url) {
      await loadReferenceData();
      const r = await registerAndRate(sb, url, { dry: dry(), verdicts });
      cached = null;
      if ("reason" in r) return { sourceId: null, tier: null, refused: r.reason };
      return { sourceId: "source_id" in r ? r.source_id : null, tier: r.tier };
    },
    matchTarget(pool, identity) {
      const m = verifyPoolTargetMatch({ title: identity.title, item_type: identity.item_type, instrument_type: identity.instrument_type, instrument_identifier: identity.identifier, canonical_instrument_key: identity.canonical_instrument_key }, pool);
      return { verdict: m.verdict, reason: m.best.reason, expected: m.best.expected, conflicting: m.best.conflicting, score: m.best.score };
    },
    officialness(url, text, ctx) {
      const o = officialnessOf(text, hostOf(url), { hostTier: ctx.hostTier, floorTier: ctx.floorTier });
      return { path: o.path, cleanBody: o.cleanBody };
    },
    classifyBody(body) {
      const v = classifyBody(body);
      return { errorBody: !isStorableClass(v.class), reason: v.class };
    },
    classTierForHost: (host) => classTierForHost(host),
    holdingsGate: (c) => ({ present: holdingsPresent(c), detail: `snapshotBytes=${c.snapshotBytes} usablePoolRows=${c.usablePoolRows}` }),
    fetchAllowed: () => gate.allowed,
    async capture(url, ref): Promise<CaptureResult> {
      try {
        const r = await capture(url, { family: captureFamily(url), key: ref.key }, fetchDeps);
        if (r.usable && r.text) return { ok: true, text: r.text };
        const wall = detectAccessWall(r.attempts[r.attempts.length - 1]?.head ?? "");
        return { ok: false, text: "", ...(wall ? { wall: { kind: wall.class } } : {}), reason: r.holdReason ?? "unusable capture" };
      } catch (e) {
        return { ok: false, text: "", reason: e instanceof Error ? e.message : String(e) };
      }
    },
  };

  const io: Io = {
    async fetchText(url) {
      const r = await fetchDirect(url, fetchDeps, { max: 10_000_000, keepHtml: true });
      if (r.status !== 200) throw new Error(`HTTP ${r.status || "network"} for ${url}`);
      return r.html ?? r.text;
    },
    async fetchBytes(url) {
      await assertFetchAllowed(url, null, hold);
      const res = await doFetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`${url}: ${buf.length} bytes exceeds the ${MAX_BYTES}-byte read cap`);
      return buf;
    },
    async fetchJson(url) {
      return JSON.parse(await io.fetchText(url)) as never;
    },
  };

  const text = (v: unknown): string | null => (typeof v === "string" ? v : null);
  // The mint's gate hands a seed; the entity module matches a corpus row: the seed's own subject fields are that row (no id, so it never matches itself).
  const entities: EntityDeps = { congruence, sourceRole, matchExistingSubject: (seed, corpus) => matchExistingSubject({ id: "", title: text(seed.title), instrument_identifier: text(seed.instrument_identifier), source_url: text(seed.source_url) }, corpus) };
  const identity: IdentityHelpers = { deriveKey, sameInstitution: (a, b) => !!institutionKey(a) && institutionKey(a) === institutionKey(b) };
  const connect = createConnectDeps({ getDb: () => sb, now });
  const mintCtx: MintCtx = { sb, entities, connect, now };
  const intake: IntakeDeps = { sb, sources, mint: bindMint(mintCtx), connect, recorder };
  const flushCache: MintRunDeps["flushCache"] = async (tags) => {
    const base = env.NEXT_PUBLIC_APP_URL;
    if (!base || !env.WORKER_SECRET) return { error: "cache flush not configured: NEXT_PUBLIC_APP_URL and WORKER_SECRET are required" };
    const res = await doFetch(`${base}/api/revalidate`, { method: "POST", headers: { "content-type": "application/json", "x-worker-secret": env.WORKER_SECRET }, body: JSON.stringify({ tags }), signal: AbortSignal.timeout(20_000) });
    return { error: res.ok ? null : `revalidate answered HTTP ${res.status}` };
  };
  const mintRun: MintRunDeps = { sb, now, entities, connect, recorder, identity, fetch: fetchDeps, isSeriesKey, flushCache };

  const registry = createMethodRegistry();
  // The market slice's own arithmetic is the default (P2-11); a caller passes `market: null` to leave it unwired (the fail-closed test), or its own pair.
  const marketDeps: MarketMethodDeps | null = opts.market === undefined ? { computeSeriesDeltas: (rows) => computeSeriesDeltas(rows as never), carbonIntensity: (factor) => carbonIntensity(factor as never) } : opts.market;
  if (marketDeps) registerMarketMethods(registry, marketDeps);
  const market: MarketSeriesDeps | null = marketDeps ? { registry, computeSeriesDeltas: (rows) => marketDeps.computeSeriesDeltas(rows as unknown as Parameters<MarketMethodDeps["computeSeriesDeltas"]>[0]) } : null;
  const producers: BuiltDeps["producers"] = { sb, fetch: (url, init) => doFetch(url, init as RequestInit | undefined), recorder, env, sleep, summaryDir: env.PRODUCER_SUMMARY_DIR ?? null, market, mint: mintCtx, verdicts };
  const learning: LearningDeps = { questionFlagRow };
  // The service client carries its own key, so invoking the function through it is the service-role call the worker requires (the worker reads no gate: the capture stage did).
  const worker: CaptureWorker =
    opts.worker ??
    (async (input) => {
      const { data, error } = await sb.functions.invoke("capture-worker", { body: input });
      return error ? { status: 500, body: { error: error.message } } : { status: 200, body: (data ?? {}) as Record<string, unknown> };
    });
  return {
    sb, env, now, context, recorder, gate, sources, entities, identity, fetch: fetchDeps, io, mintCtx, intake, mintRun, connect, producers, catalog: opts.catalog ?? PRODUCER_CATALOG, worker, marketMethods: marketDeps, statutory: opts.statutory ?? null, edgeAuthors: opts.edgeAuthors ?? null, assessment: opts.assessment ?? researchAssessment, registry, learning,
    workspace: workspaceWiring(sb), halted: async () => (await import("@/core/harness/run")).halted(sb).then((h) => h.halted), loadReferenceData,
  };
}

/** The workspace handlers' cross-slice members. `portfolio` is the held-items read layer (P2-13); the pages read it with the caller's own client, the API route with this one. */
export function workspaceWiring(sb: Db): Partial<WorkspaceDeps> {
  return {
    navCounts: (who) => getNavCounts(navCountSources(sb, who)),
    // The same counts the old admin attention route read: one rpc, one row. A failed read throws, so the bootstrap names it degraded and the shell shows "unknown", never a zero.
    adminAttention: async () => {
      const { data, error } = await sb.rpc("admin_attention_counts");
      if (error) throw new Error(`admin_attention_counts failed: ${error.message}`);
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, number> | undefined;
      if (!row) throw new Error("admin_attention_counts returned no row");
      return row;
    },
    itemHref: (item) => surfaceHref(surfaceOf(item.type, item.domain), item.id) ?? `/regulations/${encodeURIComponent(item.id)}`,
    revalidateWorkspaceData: () => void import("next/cache").then((m) => m.revalidateTag("app-data", "max")),
    timePhase,
    withServerTiming,
    portfolio: portfolioDeps(sb),
  };
}

export interface ManifestEntry {
  member: string;
  status: "wired" | "owed";
  owner?: string;
  present(d: BuiltDeps): boolean;
}
const fn = (v: unknown): boolean => typeof v === "function";
/** Every provider-to-consumer member this module is responsible for. `wired` members are checked at startup; `owed` members name the slice that supplies them. */
export const MANIFEST: readonly ManifestEntry[] = [
  ...(["resolveSource", "registerAndRate", "matchTarget", "officialness", "classifyBody", "classTierForHost", "holdingsGate", "fetchAllowed", "capture"] as const).map((m): ManifestEntry => ({ member: `intake.sources.${m}`, status: "wired", present: (d) => fn(d.intake.sources[m]) })),
  { member: "intake.mint.mintItem", status: "wired", present: (d) => fn(d.intake.mint.mintItem) },
  ...(["connect", "extractAndInsertForwardEvents", "deriveObligations", "linkEntities"] as const).map((m): ManifestEntry => ({ member: `intake.connect.${m}`, status: "wired", present: (d) => fn(d.intake.connect[m]) })),
  { member: "intake.recorder.recordRun", status: "wired", present: (d) => fn(d.intake.recorder.recordRun) },
  ...(["congruence", "sourceRole", "matchExistingSubject"] as const).map((m): ManifestEntry => ({ member: `mintRun.entities.${m}`, status: "wired", present: (d) => fn(d.mintRun.entities[m]) })),
  ...(["deriveKey", "sameInstitution"] as const).map((m): ManifestEntry => ({ member: `mintRun.identity.${m}`, status: "wired", present: (d) => fn(d.mintRun.identity[m]) })),
  { member: "mintRun.isSeriesKey", status: "wired", present: (d) => fn(d.mintRun.isSeriesKey) },
  { member: "mintRun.flushCache", status: "wired", present: (d) => fn(d.mintRun.flushCache) },
  { member: "producers.recorder", status: "wired", present: (d) => fn(d.producers.recorder.recordRun) },
  { member: "producers.fetch", status: "wired", present: (d) => fn(d.producers.fetch) },
  { member: "learning.questionFlagRow", status: "wired", present: (d) => fn(d.learning.questionFlagRow) },
  { member: "producers.market (computeSeriesDeltas and the market methods)", status: "wired", present: (d) => d.producers.market !== null },
  { member: "propagation EdgeAuthors (authorCarbonIntensityEdges)", status: "owed", owner: "P2-11 market surface (carbonIntensity)", present: () => false },
  { member: "producers.verdicts (host verdicts as a table, IMP-054)", status: "wired", present: (d) => d.producers.verdicts instanceof Map },
  { member: "loadReferenceData (host_verdicts and market_series_items, read once per turn)", status: "wired", present: (d) => fn(d.loadReferenceData) },
  ...(["itemHref", "revalidateWorkspaceData", "navCounts", "adminAttention", "timePhase", "withServerTiming"] as const).map((m): ManifestEntry => ({ member: `workspace.${m}`, status: "wired", present: (d) => fn(d.workspace[m]) })),

  { member: "workspace.portfolio", status: "wired", present: (d) => d.workspace.portfolio !== undefined },
  { member: "dashboard.themeChips (the cross-page theme view)", status: "owed", owner: "P2-10 (src/core/themes themeChips)", present: () => dashboardDeps().themeChips !== undefined },
  { member: "assistant.operationsFacts (the Operations data block)", status: "owed", owner: "P2-12 (src/features/operations/ask-context.ts)", present: () => assistantDeps().operationsFacts !== undefined },
];

/** IMP-026: which required members are unwired (refuse), and which are owed to a slice that is not merged (reported). */
export function startupCheck(d: BuiltDeps): { missing: string[]; owed: { member: string; owner: string }[] } {
  return {
    missing: MANIFEST.filter((e) => e.status === "wired" && !e.present(d)).map((e) => e.member),
    owed: MANIFEST.filter((e) => e.status === "owed" && !e.present(d)).map((e) => ({ member: e.member, owner: e.owner ?? "unassigned" })),
  };
}

/** IMP-026: on Vercel (the deployed app) a required member that is unwired refuses to serve; elsewhere (a CI runner, a laptop) the report is returned for the caller to show and the routes that need the member answer 503 at request time. */
export function enforceWired(report: { missing: string[] }, env: Env = process.env): void {
  if (report.missing.length && env.VERCEL === "1") throw new Error(`startup refused: required dependencies are not wired: ${report.missing.join(", ")}`);
}

let wiredOnce = false;
export const SERVICE_MEMBER = "service client (no service key configured)";

/** Wire the app's deps once at startup: the workspace handlers' members and the intake route's factory. Deps are built from what the environment provides: without a service key nothing service-dependent is wired (isServiceConfigured is the only test, serviceClient is never called to decide) and the report names it; on Vercel that refuses to start. */
export function wireAll(env: Env = process.env): { missing: string[]; owed: { member: string; owner: string }[] } {
  if (!isServiceConfigured()) {
    const report = { missing: [SERVICE_MEMBER], owed: [] };
    enforceWired(report, env);
    return report;
  }
  const sb = serviceClient();
  const probe = buildDeps(sb, env);
  const report = startupCheck(probe);
  enforceWired(report, env);
  if (wiredOnce) return report;
  wiredOnce = true;
  wireWorkspaceDeps(probe.workspace);
  setIntakeDepsFactory((db) => buildDeps(db, env).intake);
  return report;
}
