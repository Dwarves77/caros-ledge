// Ported from old_repo/src/lib/corrections/item-corrections.mjs (lines 1-231)
// The correction model: the newest active correction per target decides; tombstoned pairs and removed tags never come back; suppressed
// facts never render. Every reader fails closed (a failed read throws, it is never an empty list). Pure planners first, readers last.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { isUuid } from "@/core/http/parse";

const TARGET_KINDS = ["fact", "tag", "connection", "section_text", "full_brief"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
const OPS_BY_KIND: Readonly<Record<TargetKind, readonly string[]>> = {
  fact: ["suppress", "replace"],
  tag: ["add", "remove"],
  connection: ["add", "remove"],
  section_text: ["replace"],
  full_brief: ["replace"],
};
export const TAG_COLUMNS = ["topic_tags", "operational_scenario_tags", "compliance_object_tags"] as const;
export type TagColumn = (typeof TAG_COLUMNS)[number];
export const EDGE_RELATIONSHIPS = ["related", "supersedes", "implements", "conflicts", "amends", "depends_on"] as const;

export interface Correction {
  id?: string;
  item_id: string;
  target_kind: string;
  target_ref: string;
  op: string;
  value?: Record<string, unknown> | null;
  machine_value?: ({ claim_text?: string } & Record<string, unknown>) | null;
  reason?: string;
  created_at?: string | null;
  revoked_at?: string | null;
  [k: string]: unknown;
}
export interface ClaimRef {
  id?: string | number | null;
  claim_text?: string | null;
  [k: string]: unknown;
}

/** `topic_tags:emissions` to its column and tag; null when the ref is not that shape. */
function parseTagRef(ref: unknown): { column: TagColumn; tag: string } | null {
  if (typeof ref !== "string") return null;
  const i = ref.indexOf(":");
  if (i <= 0) return null;
  const column = ref.slice(0, i);
  const tag = ref.slice(i + 1);
  return (TAG_COLUMNS as readonly string[]).includes(column) && tag.trim() !== "" ? { column: column as TagColumn, tag } : null;
}

const activeCorrections = (rows: readonly Correction[] | null | undefined): Correction[] => (rows ?? []).filter((r) => r && (r.revoked_at === null || r.revoked_at === undefined));

const newer = (a: Correction, b: Correction): boolean => {
  const ta = Date.parse(a.created_at ?? "") || 0;
  const tb = Date.parse(b.created_at ?? "") || 0;
  return ta !== tb ? ta > tb : String(a.id ?? "") > String(b.id ?? "");
};

/** The newest active correction per (item, target kind, target ref): latest wins. */
export function latestPerTarget(rows: readonly Correction[] | null | undefined): Map<string, Correction> {
  const out = new Map<string, Correction>();
  for (const r of activeCorrections(rows)) {
    const key = `${r.item_id}|${r.target_kind}|${r.target_ref}`;
    const cur = out.get(key);
    if (!cur || newer(r, cur)) out.set(key, r);
  }
  return out;
}

const pairKey = (a: unknown, b: unknown): string => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

/** Unordered pairs whose newest active connection correction is a remove. */
export function tombstonedPairKeys(rows: readonly Correction[] | null | undefined): Set<string> {
  const newest = new Map<string, Correction>();
  for (const r of activeCorrections(rows)) {
    if (r.target_kind !== "connection") continue;
    const k = pairKey(r.item_id, r.target_ref);
    const cur = newest.get(k);
    if (!cur || newer(r, cur)) newest.set(k, r);
  }
  const out = new Set<string>();
  for (const [k, r] of newest) if (r.op === "remove") out.add(k);
  return out;
}
export const isPairTombstoned = (tombstones: Set<string> | undefined, a: unknown, b: unknown): boolean => tombstones instanceof Set && tombstones.has(pairKey(a, b));

/** Tags an admin removed from one item, per column (latest wins: a later add clears an earlier remove). */
export function removedTagsFor(rows: readonly Correction[] | null | undefined, itemId: string): Record<TagColumn, Set<string>> {
  const out: Record<TagColumn, Set<string>> = { topic_tags: new Set(), operational_scenario_tags: new Set(), compliance_object_tags: new Set() };
  for (const r of latestPerTarget(rows).values()) {
    if (r.target_kind !== "tag" || r.item_id !== itemId || r.op !== "remove") continue;
    const p = parseTagRef(r.target_ref);
    if (p) out[p.column].add(p.tag);
  }
  return out;
}

export interface TagProposalLike {
  field: string;
  tag: string;
}
/** Split proposals into those that may be written and those an admin removed (never re-proposed). */
export function filterTagProposals<P extends TagProposalLike>(proposals: readonly P[] | null | undefined, removed: Partial<Record<string, Set<string>>> | null | undefined): { kept: P[]; blocked: P[] } {
  const kept: P[] = [];
  const blocked: P[] = [];
  for (const p of proposals ?? []) {
    if (removed?.[p.field]?.has(p.tag)) blocked.push(p);
    else kept.push(p);
  }
  return { kept, blocked };
}

/** A predicate over a claim: true when the newest decider for it is a suppress (matched by id first, then by the machine text). */
export function suppressedClaimMatcher(rows: readonly Correction[] | null | undefined, itemId: string): (claim: ClaimRef) => boolean {
  const facts = [...latestPerTarget(rows).values()].filter((r) => r.target_kind === "fact" && r.item_id === itemId);
  return (claim) => {
    let idDecider: Correction | null = null;
    let textDecider: Correction | null = null;
    for (const r of facts) {
      const byId = claim?.id !== undefined && claim.id !== null && String(claim.id) === r.target_ref;
      const byText = typeof claim?.claim_text === "string" && !!r.machine_value && r.machine_value.claim_text === claim.claim_text;
      if (byId) {
        if (!idDecider || newer(r, idDecider)) idDecider = r;
      } else if (byText && (!textDecider || newer(r, textDecider))) textDecider = r;
    }
    const decider = idDecider ?? textDecider;
    return decider !== null && decider.op === "suppress";
  };
}

/** Active fact corrections whose claim is no longer on the item (reported, never deleted). */
export function findOrphanedFactCorrections(rows: readonly Correction[] | null | undefined, claims: readonly ClaimRef[] | null | undefined): Correction[] {
  const list = claims ?? [];
  return activeCorrections(rows).filter((r) => {
    if (r.target_kind !== "fact") return false;
    return !list.some((c) => {
      if (c?.id !== undefined && c.id !== null && String(c.id) === r.target_ref) return true;
      if (typeof c?.claim_text !== "string") return false;
      return c.claim_text === r.machine_value?.claim_text || (!!r.value && c.claim_text === r.value.claim_text);
    });
  });
}

export interface CorrectionInput {
  target_kind: TargetKind;
  target_ref: string;
  op: string;
  value: Record<string, unknown> | null;
  reason: string;
}
export type Validated = { ok: true; input: CorrectionInput } | { ok: false; code: string; error: string };
const bad = (code: string, error: string): Validated => ({ ok: false, code, error });
const text = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** The input rules of an admin correction, one code per refusal. */
export function validateCorrectionInput(body: unknown): Validated {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason) return bad("reason_required", "reason is required: say why the machine value is being overridden");
  const kind = b.target_kind as TargetKind;
  if (!TARGET_KINDS.includes(kind)) return bad("target_kind_invalid", `target_kind must be one of ${TARGET_KINDS.join(", ")}`);
  const op = b.op;
  if (typeof op !== "string" || !OPS_BY_KIND[kind].includes(op)) return bad("op_invalid", `op for ${kind} must be one of ${OPS_BY_KIND[kind].join(", ")}`);
  const ref = typeof b.target_ref === "string" ? b.target_ref.trim() : "";
  if (!ref) return bad("target_ref_required", "target_ref is required");
  const raw = b.value === undefined ? null : b.value;
  if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) return bad("value_invalid", "value must be a JSON object when given");
  const value = raw as Record<string, unknown> | null;
  if (kind === "tag" && !parseTagRef(ref)) return bad("target_ref_invalid", `a tag target_ref is <${TAG_COLUMNS.join("|")}>:<tag>`);
  if ((kind === "fact" || kind === "connection") && !isUuid(ref)) return bad("target_ref_invalid", `a ${kind} target_ref is a uuid`);
  if (kind === "full_brief" && ref !== "full_brief") return bad("target_ref_invalid", "a full_brief target_ref is the literal full_brief");
  if (kind === "full_brief" && !text(value?.text)) return bad("value_invalid", 'a full_brief replace needs value {"text": "..."}');
  if (kind === "section_text" && !text(value?.content_md)) return bad("value_invalid", 'a section_text replace needs value {"content_md": "..."}');
  if (kind === "fact" && op === "replace" && !(text(value?.source_span) && typeof value?.search_result_id === "string" && isUuid(value.search_result_id))) {
    return bad("fact_needs_span", 'a fact replace needs value {"source_span", "search_result_id"} (ADR-016: the span must be verbatim in a held capture)');
  }
  if (kind === "connection" && op === "add" && value?.relationship !== undefined && !(EDGE_RELATIONSHIPS as readonly unknown[]).includes(value.relationship)) {
    return bad("value_invalid", `relationship must be one of ${EDGE_RELATIONSHIPS.join(", ")}`);
  }
  return { ok: true, input: { target_kind: kind, target_ref: ref, op, value, reason } };
}

/** Every correction row of one item. A failed read throws. */
export async function readItemCorrections(sb: Db, itemId: string): Promise<Correction[]> {
  const { data, error } = await sb.from("item_corrections").select("*").eq("item_id", itemId);
  if (error) throw new Error(`item_corrections read failed: ${error.message}`);
  return (data ?? []) as Correction[];
}

/** The connection corrections touching an item from either end (a removal filed on the other item still tombstones the pair). */
export async function readConnectionCorrectionsFor(sb: Db, itemId: string): Promise<Correction[]> {
  const own = (await readItemCorrections(sb, itemId)).filter((r) => r.target_kind === "connection");
  const { data, error } = await sb.from("item_corrections").select("*").eq("target_kind", "connection").eq("target_ref", itemId);
  if (error) throw new Error(`item_corrections read failed: ${error.message}`);
  const seen = new Set(own.map((r) => r.id));
  return [...own, ...((data ?? []) as Correction[]).filter((r) => !seen.has(r.id))];
}

/** The connection corrections that touch ANY of the items from either end, read in id chunks (a writer reads only the pairs it is about to write, never the table). */
export async function readConnectionCorrectionsForMany(sb: Db, itemIds: readonly string[]): Promise<Correction[]> {
  const byId = new Map<string, Correction>();
  const take = (rows: Correction[]) => rows.forEach((r, i) => byId.set(String(r.id ?? `${r.item_id}|${r.target_ref}|${r.created_at ?? i}`), r));
  for (const column of ["item_id", "target_ref"] as const) {
    take(
      await fetchAllByIdChunks<Correction>(
        itemIds,
        async (slice) => {
          const { data, error } = await sb.from("item_corrections").select("*").eq("target_kind", "connection").in(column, slice);
          if (error) throw new Error(`item_corrections read failed: ${error.message}`);
          return (data ?? []) as Correction[];
        },
        { manyPerId: true },
      ),
    );
  }
  return [...byId.values()];
}

/** The whole table, total-ordered by id and capped. */
export async function readAllCorrections(sb: Db): Promise<Correction[]> {
  return fetchAllRows<Correction>((from, to) => sb.from("item_corrections").select("*").order("id", { ascending: true }).range(from, to), { cap: 200_000 });
}
