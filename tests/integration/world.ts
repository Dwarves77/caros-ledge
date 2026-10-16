// The integration world: ONE fixture database and ONE fixture transport that the whole turn runs over with the real wiring (buildDeps). Nothing here stubs a slice: the registered sources, the feed, the pages
// and the market document are data; every stage is the real stage calling the real module. Surface slices extend this file with their reader (WAVE-2-COMMON addendum 2).
import { drain, type WorkerDeps } from "../../supabase/functions/capture-worker/process.ts";
import { buildDeps, type BuiltDeps } from "@/core/turn/wiring";
import { ecbFx } from "@/features/market/producers";
import type { MarketMethodDeps } from "@/core/propagation";
import type { Catalog } from "@/core/producers";
import { PRODUCER_CATALOG } from "@/core/turn/wiring";

import { MemDb, installPortalLedgerRpc, installPropagationRpcs, type Row } from "../_support/memdb.ts";
import { OFFICIAL_TEXT } from "../intake/fixtures.ts";
import { installProvenanceRpc } from "../intake/fixtures.ts";

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const SRC = "b0000000-0000-4000-8000-000000000001";
export const DOC = "b0000000-0000-4000-8000-000000000002";
export const CENSUS = "c0000000-0000-4000-8000-000000000001";
export const PORTAL_URL = "https://eur-lex.europa.eu/";
export const FEED_URL = "https://eur-lex.europa.eu/feed.xml";
export const DOC_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999";
export const NEW_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R0001";
export const TITLE = "Regulation (EU) 2023/9999 establishing greenhouse gas emissions reduction duties for freight operators";
/** The regulation page as the publisher serves it: the instrument text plus the notices around it (the capture policy refuses a body under 1,000 characters). */
export const DOC_TEXT = `${OFFICIAL_TEXT}
${"Notice. This consolidated text is provided for information. Only the Union legislation published in the Official Journal of the European Union is deemed authentic. ".repeat(4)}`;
export { OFFICIAL_TEXT };

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender><Cube><Cube time="2026-10-15"><Cube currency="USD" rate="1.1000"/></Cube></Cube></gesmes:Envelope>`;
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>EUR-Lex</title><item><title>Regulation (EU) 2025/1 on freight emissions</title><link>${NEW_URL}</link><pubDate>Wed, 15 Oct 2025 08:00:00 GMT</pubDate></item></channel></rss>`;
const HOMEPAGE = `<html><head><title>EUR-Lex</title></head><body><p>${"EUR-Lex gives access to European Union law, the Official Journal and preparatory acts. Newly published this week. ".repeat(12)}</p><a href="${NEW_URL}">Regulation 2025/1</a></body></html>`;

export interface Requests {
  urls: string[];
}
/** The transport: routes by URL, records every request. Anything not routed is a 404, so a stage that reaches outside the fixture fails visibly. */
export function transport(over: Record<string, () => Response> = {}): { fetchImpl: typeof fetch; requests: Requests } {
  const requests: Requests = { urls: [] };
  const routes: Record<string, () => Response> = {
    [FEED_URL]: () => new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } }),
    [PORTAL_URL]: () => new Response(HOMEPAGE, { status: 200, headers: { "content-type": "text/html" } }),
    [DOC_URL]: () => new Response(DOC_TEXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
    "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml": () => new Response(ECB_XML, { status: 200, headers: { "content-type": "application/xml" } }),
    ...over,
  };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.urls.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** The fixture's stand-in for the market slice's arithmetic (P2-11 owns the real computeSeriesDeltas and carbonIntensity): the one-week delta between the latest point and the earliest in the window. */
export const MARKET: MarketMethodDeps = {
  carbonIntensity: () => ({ ok: false, reason: "no emission factors in the fixture" }),
  computeSeriesDeltas: (rows) => {
    const pts = [...rows].sort((a, b) => String(a.reference_period).localeCompare(String(b.reference_period)));
    const latest = pts[pts.length - 1];
    const first = pts[0];
    if (!latest || !first || latest === first) return { delta1w: { insufficientHistory: true } };
    return { latest: { date: latest.reference_period, unit: latest.unit, currency: latest.currency }, delta1w: { value: Number(latest.value_numeric) - Number(first.value_numeric), fromDate: String(first.reference_period) } };
  },
};

/** The database triggers the schema carries, as stand-ins: a write to a figure table emits a propagation event (the outbox), an item update does too. */
function installTriggers(db: MemDb): void {
  let n = 0;
  db.afterWrite = (c, d) => {
    if (c.table === "market_series" && (c.op === "insert" || c.op === "upsert")) {
      for (const r of d.rows("market_series").filter((x) => x.__emitted === undefined)) {
        r.__emitted = true;
        d.rows("propagation_events").push({ event_id: ++n, occurred_at: NOW.toISOString(), table_name: "market_series", row_pk: r.id, entity_id: null, change_kind: "insert", new_row: { ...r }, drained_at: null });
      }
    }
  };
}

export const SLOTS = [{ item_type: "regulation", slot_key: "binding_position", description: "applicability" }, { item_type: "regulation", slot_key: "due_date", description: "due date" }];

export function makeWorld(opts: { cadence?: "off" | "weekly" } = {}) {
  const db = new MemDb({}, {});
  const src = (id: string, url: string, name: string, over: Row = {}): Row => ({ id, name, url, base_tier: 1, tier_override: null, status: "active", institution_id: null, category: "regulatory", auto_run_enabled: true, processing_paused: false, last_content_hash: "0".repeat(64), last_checked: null, ...over });
  db.seed("system_state", [{ id: true, scrape_cadence: opts.cadence ?? "weekly", scrape_start_date: "2026-10-15", global_processing_paused: false }]);
  db.seed("sources", [src(SRC, PORTAL_URL, "EUR-Lex", { rss_feed_url: FEED_URL }), src(DOC, DOC_URL, "Regulation 2023/9999")]);
  db.seed("census_worklist", [{ id: CENSUS, source_id: SRC, document_url: DOC_URL, title: TITLE, surface_tags: [], instrument_identifier: "32023R9999", dryrun_disposition: "would_mint", hold_reason: null, notes: null, is_archived: false, enumeration_status: "discovered" }]);
  db.seed("item_type_required_slots", SLOTS);
  db.seed("screen_verdicts", []);
  db.seed("market_series", [{ id: "d0000000-0000-4000-8000-000000000001", series_key: "ecb-fx:eur-usd", label: "EUR/USD", value_numeric: 1.05, unit: "USD/EUR", currency: "USD", derivation: "observed", origin_class: "official", source_key: "ecb", reference_period: "2026-10-08", as_at_date: "2026-10-08", __emitted: true }]);
  installProvenanceRpc(db);
  installPropagationRpcs(db);
  installPortalLedgerRpc(db);
  installTriggers(db);
  return db;
}

export interface Fixture {
  db: MemDb;
  d: BuiltDeps;
  requests: Requests;
}
/** buildDeps over the fixture: the real wiring, the fixture transport, the fixture clock, the worker drained in process (the Edge Function's own code), the market producer armed (the reviewed constant is code, so the fixture arms a copy). */
export function fixture(opts: { cadence?: "off" | "weekly"; routes?: Record<string, () => Response> } = {}): Fixture {
  const db = makeWorld(opts.cadence ? { cadence: opts.cadence } : {});
  const { fetchImpl, requests } = transport(opts.routes);
  const catalog: Catalog = { ...PRODUCER_CATALOG, "ecb-fx": { ...ecbFx, enabled: true } };
  const env = { MARKET_PRODUCER_ECB_FX_ENABLED: "1" };
  const worker: WorkerDeps = { db: db.client, fetchImpl, env, now: () => NOW.getTime() } as WorkerDeps;
  const d = buildDeps(db.client, env, { now: () => NOW, fetchImpl, market: MARKET, catalog, sleep: async () => undefined, worker: (input) => drain(worker, input) });
  return { db, d, requests };
}
