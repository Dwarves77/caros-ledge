// DERIVE-2 V1 + OBL-DERIVE-1 (ruling 65): the transport mode(s) a verbatim span names; else its instrument's title and identifier (the instrument's scope applies to every obligation in it); else the modes the instrument itself declares (its cites_mode refs, else its
// transport_modes leg tokens). The rules are data (object-rules.json modeClassifiers, zod-validated here at import, every mode token checked against the transport_mode vocabulary); classifyMode is pure and returns the tokens, the rule ids and the basis. An instrument that
// declares no mode and matches no rule is no mode: never a default.
import { z } from "zod";

import { LEG_MODE_CODES, normaliseMode } from "@/core/contracts/vocabularies";
import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";

import rulesJson from "./data/object-rules.json";

const classifier = z.object({ id: z.string().min(1), pattern: z.string().min(1), modes: z.array(z.string()).min(1), on: z.enum(["span", "instrument"]), consignment_wide: z.boolean().optional() });
const MODE_CLASSIFIERS = z.array(classifier).min(1).parse(rulesJson.modeClassifiers).map((c) => ({ ...c, re: new RegExp(c.pattern, "i") }));
for (const c of MODE_CLASSIFIERS) {
  const alien = c.modes.find((m) => !LEG_MODE_CODES.includes(m));
  if (alien) throw new Error(`object-rules.json modeClassifiers "${c.id}": "${alien}" is not a leg mode of the transport_mode vocabulary`);
  if (c.consignment_wide && LEG_MODE_CODES.some((m) => !c.modes.includes(m))) throw new Error(`object-rules.json modeClassifiers "${c.id}": a consignment-wide rule names every leg mode`);
}

export interface ModeVerdict {
  /** Leg modes in vocabulary order; empty when nothing classified. */
  modes: string[];
  ruleIds: string[];
  /** Where the verdict was read: the span, the instrument's title (counted apart), the instrument's own declared modes (ruling 65), or nowhere. */
  basis: "span" | "title" | "instrument" | null;
  /** The text each matching rule matched. */
  matched: string[];
  consignmentWide: boolean;
}

export function classifyMode(span: string, instrument: { title?: string | null | undefined; identifier?: string | null | undefined }, declared: { instrumentModes: readonly string[] } = { instrumentModes: [] }): ModeVerdict {
  const read = (on: "span" | "instrument", text: string) => MODE_CLASSIFIERS.filter((c) => c.on === on).flatMap((c) => { const m = c.re.exec(text); return m ? [{ c, matched: m[0] }] : []; });
  const fromSpan = read("span", span);
  const hits = fromSpan.length ? fromSpan : read("instrument", `${instrument.title ?? ""} ${instrument.identifier ?? ""}`);
  const modes = LEG_MODE_CODES.filter((m) => hits.some((h) => h.c.modes.includes(m)));
  if (modes.length) return { modes, ruleIds: hits.map((h) => h.c.id), basis: fromSpan.length ? "span" : "title", matched: hits.map((h) => h.matched), consignmentWide: hits.some((h) => h.c.consignment_wide === true) };
  const declaredModes = LEG_MODE_CODES.filter((m) => declared.instrumentModes.includes(m));
  return { modes: declaredModes, ruleIds: [], basis: declaredModes.length ? "instrument" : null, matched: [], consignmentWide: false };
}

/**
 * The modes each instrument item declares (ruling 65): the closed mode tokens of the mode entities its cites_mode refs file it under (a mode entity's tokens are the basis.value of its typed-column cites_mode refs, as core/coupling/ontology reads them), else its transport_modes
 * column tokens that are leg modes. An item with neither is absent from the map.
 */
export async function readInstrumentModes(sb: Db, items: readonly { id: string; transport_modes?: readonly string[] | null | undefined }[]): Promise<Map<string, string[]>> {
  const refs = await fetchAllByIdChunks<{ ref_id: string; entity_id: string }>(items.map((i) => i.id), async (slice) => {
    const { data, error } = await sb.from("entity_refs").select("ref_id, entity_id").eq("ref_table", "intelligence_items").eq("role", "cites_mode").in("ref_id", slice);
    if (error) throw new Error(`instrument modes: entity_refs read failed: ${error.message}`);
    return data ?? [];
  }, { manyPerId: true });
  const entities = [...new Set(refs.map((r) => r.entity_id))];
  const tokensOf = new Map<string, Set<string>>();
  for (let i = 0; i < entities.length; i += 50) {
    const slice = entities.slice(i, i + 50);
    const rows = await fetchAllRows<{ entity_id: string; basis: { value?: unknown } | null }>((from, to) => sb.from("entity_refs").select("entity_id, basis").eq("role", "cites_mode").contains("basis", { column: "mode" }).in("entity_id", slice).order("entity_id", { ascending: true }).order("ref_table", { ascending: true }).order("ref_id", { ascending: true }).range(from, to));
    for (const r of rows) { const t = normaliseMode(r.basis?.value); if (t) tokensOf.set(r.entity_id, new Set([...(tokensOf.get(r.entity_id) ?? []), t])); }
  }
  const out = new Map<string, string[]>();
  for (const it of items) {
    const filed = LEG_MODE_CODES.filter((m) => refs.some((r) => r.ref_id === it.id && tokensOf.get(r.entity_id)?.has(m)));
    const column = LEG_MODE_CODES.filter((m) => (it.transport_modes ?? []).some((t) => normaliseMode(t) === m));
    const modes = filed.length ? filed : column;
    if (modes.length) out.set(it.id, modes);
  }
  return out;
}
