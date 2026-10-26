// New in DERIVE-3 (scripts/ci/new-files/derive-3.txt): a capture of an instrument's own page belongs to that instrument's item. The obligation guard refuses an object whose capture is not bound to the instrument item, so the cause is a capture stored with no item: a page
// whose CELEX (a consolidated 0YYYYTNNNN-date text is of the instrument 3YYYYTNNNN) or ELI identifier names exactly one live intelligence_items row (its canonical key or instrument identifier), or whose URL is that row's own source URL, is stored WITH that item.
// itemForCitedUrl is the capture path's question (captureCited asks it before it stores); bindInstrumentCaptures applies the same rule to the captures already stored with no item and reports the remainder with reasons. The guard is untouched.
import { admitItems } from "@/core/derived/admissible";
import { fetchAllRows, type Db } from "@/core/db";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";

export interface BindItem { id: string; canonical_instrument_key: string | null; instrument_identifier: string | null; source_url: string | null }

const ELI_TYPE: Readonly<Record<string, string>> = { reg: "R", reg_impl: "R", reg_del: "R", dir: "L", dir_impl: "L", dir_del: "L", dec: "D", dec_impl: "D", dec_del: "D" };
const CELEX_RE = /[?&]uri=CELEX(?::|%3A)([\w()-]+)/i;
const ELI_RE = /\/eli\/([a-z_]+)\/(\d{4})\/(\d+)(?:\/|$)/i;
const plain = (url: string): string => url.trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

/** The identifiers a captured URL names: its CELEX (the base instrument of a consolidated text), the CELEX an ELI path implies, and the ELI's `YYYY/N` short form. */
function instrumentKeysOf(url: string): { celex: string | null; short: string | null } {
  const celex = CELEX_RE.exec(url)?.[1]?.toUpperCase().replace(/^0(\d{4}[A-Z]\d{4}).*$/, "3$1") ?? null;
  const eli = ELI_RE.exec(url);
  const letter = eli ? ELI_TYPE[(eli[1] as string).toLowerCase()] : undefined;
  if (!eli || !letter) return { celex, short: null };
  return { celex: celex ?? `3${eli[2]}${letter}${(eli[3] as string).padStart(4, "0")}`, short: `${eli[2]}/${Number(eli[3])}` };
}

/** The one live item a URL belongs to, or the reason it belongs to none. Pure. */
function boundItem(url: string, items: readonly BindItem[]): { itemId: string } | { reason: "no_key" | "no_item" | "ambiguous" } {
  const { celex, short } = instrumentKeysOf(url);
  const own = plain(url);
  const hits = items.filter((i) => {
    const key = i.canonical_instrument_key?.toUpperCase() ?? null;
    const ident = i.instrument_identifier?.replace(/^CELEX:/i, "").toUpperCase() ?? null;
    return (!!celex && (key === celex || ident === celex)) || (!!short && ident === short && (key === null || key === celex)) || (!!i.source_url && plain(i.source_url) === own);
  });
  if (hits.length === 1) return { itemId: (hits[0] as BindItem).id };
  return { reason: hits.length ? "ambiguous" : celex || short ? "no_item" : "no_key" };
}

const COLUMNS = "id, canonical_instrument_key, instrument_identifier, source_url";
/** The item a page being captured belongs to: the live items its identifiers or its URL name, read by those values alone. Null when none or more than one. */
export async function itemForCitedUrl(sb: Db, url: string): Promise<string | null> {
  const { celex, short } = instrumentKeysOf(url);
  const idents = [celex, short, celex ? `CELEX:${celex}` : null].filter((x): x is string => !!x);
  const reads = [
    idents.length ? admitItems(sb.from("intelligence_items").select(COLUMNS)).in("canonical_instrument_key", idents) : null,
    idents.length ? admitItems(sb.from("intelligence_items").select(COLUMNS)).in("instrument_identifier", idents) : null,
    admitItems(sb.from("intelligence_items").select(COLUMNS)).eq("source_url", url),
  ];
  const found = new Map<string, BindItem>();
  for (const r of await Promise.all(reads)) {
    if (r?.error) throw new Error(`bind: intelligence_items read failed: ${r.error.message}`);
    for (const i of (r?.data ?? []) as unknown as BindItem[]) found.set(i.id, i);
  }
  const hit = boundItem(url, [...found.values()]);
  return "itemId" in hit ? hit.itemId : null;
}

interface Unbound { id: string; agent_run_id: string | null; result_url: string }
/** Bind the captures stored with no item (D3): each whose URL names exactly one live item is stored with it, in both the capture and its run row; the rest are counted by reason. Idempotent: a bound capture is no longer unbound. */
export async function bindInstrumentCaptures(deps: { sb: Db }, input: { dry: boolean }): Promise<RunResult> {
  const { sb } = deps;
  const items = await fetchAllRows<BindItem>((from, to) => admitItems(sb.from("intelligence_items").select(COLUMNS)).order("id", { ascending: true }).range(from, to), { cap: 100_000 });
  const loose = await fetchAllRows<Unbound>((from, to) => sb.from("agent_run_searches").select("id, agent_run_id, result_url").is("intelligence_item_id", null).not("result_url", "is", null).order("id", { ascending: true }).range(from, to), { cap: 200_000 });
  const counts: Record<string, number> = { unbound: loose.length, bound: 0, unbound_no_key: 0, unbound_no_item: 0, unbound_ambiguous: 0 };
  const byItem = new Map<string, Unbound[]>();
  for (const c of loose) {
    const hit = boundItem(c.result_url, items);
    if ("itemId" in hit) byItem.set(hit.itemId, [...(byItem.get(hit.itemId) ?? []), c]);
    else counts[`unbound_${hit.reason}`] = (counts[`unbound_${hit.reason}`] ?? 0) + 1;
  }
  const planned = [...byItem.values()].reduce((n, l) => n + l.length, 0);
  if (input.dry) return runResult("ok", { ...counts, to_bind: planned }, [`dry: ${planned} capture(s) would be bound to ${byItem.size} item(s)`]);
  const notes: string[] = [];
  for (const [itemId, list] of byItem) {
    for (let i = 0; i < list.length; i += 100) {
      const slice = list.slice(i, i + 100);
      const caps = await sb.from("agent_run_searches").update({ intelligence_item_id: itemId }).in("id", slice.map((c) => c.id)).is("intelligence_item_id", null).select("id");
      if (caps.error) { notes.push(`bind to ${itemId}: ${caps.error.message}`); continue; }
      counts.bound = (counts.bound ?? 0) + (caps.data ?? []).length;
      const runs = await sb.from("agent_runs").update({ intelligence_item_id: itemId }).in("id", slice.flatMap((c) => (c.agent_run_id ? [c.agent_run_id] : []))).is("intelligence_item_id", null);
      if (runs.error) notes.push(`bind runs to ${itemId}: ${runs.error.message}`);
    }
  }
  return runResult(notes.length ? "partial" : "ok", counts, notes);
}
