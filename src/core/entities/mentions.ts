// Ported from old_repo/src/lib/entities/canonical-entities.mjs (lines 1-35)
// Ported from old_repo/src/lib/entities/entity-resolve.mjs (lines 1-309)
// Ported from old_repo/src/lib/sources/url-canonicalize.ts (lines 1-68)
// Mentions in item text: detect (registration numbers, CELEX ids, the named-standard dictionary plus adopted standards, standard-shaped tokens),
// resolve each against the corpus, bucket it (exactly one match is wired, anything else is surfaced, never guessed), type the lineage edge
// (implements, amends, depends_on) from the sentence around the mention, and plan the writes under the moat boundary (edges and flags only).
// matchExistingSubject is subject-identity dedup at mint: an instrument's own registration numbers are identity (operator ruling 2026-07-30).
import { canonicalizeUrl, findIdentifiers, indexOfInsensitive, ownIdentifiers, sameIdentifier, type Identifier } from "@/core/parse";
import { adoptedEntries, type AdoptedVocabulary } from "@/core/vocabulary/adopted";

import named from "./data/named-entities.json";

export const RE_STD_SHAPED = /\bISO(?:\/IEC)?\s?\d{3,5}(?:[:-]\d{4})?\b|\bEN\s?\d{3,5}\b|\b(?:Regulation|Directive)\s*\(EU\)\s*(?:19|20)\d{2}\/\d{1,4}\b/gi;

export interface DictEntry {
  canonical: string;
  re: RegExp;
  adopted?: boolean;
}
export const NAMED_ENTITIES: readonly DictEntry[] = named.named.map((n) => ({ canonical: n.canonical, re: new RegExp(n.pattern, "i") }));
export interface Mention {
  kind: "identifier" | "named" | "shaped";
  value: string;
  canonical: string;
  /** the normalised identifier key and instrument type of an identifier mention; resolution is EQUALITY on these */
  key?: string;
  type?: string | null;
}
export interface CorpusRow {
  id: string;
  title?: string | null;
  instrument_identifier?: string | null;
  source_url?: string | null;
}

const uniqBy = <T>(arr: readonly T[], key: (x: T) => string): T[] => {
  const m = new Map<string, T>();
  for (const x of arr) if (!m.has(key(x))) m.set(key(x), x);
  return [...m.values()];
};
const norm = (s: unknown): string => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function adoptedTermRegex(key: string): RegExp {
  const words = String(key ?? "").split(/[\s-]+/).filter(Boolean).map(escapeRe);
  return new RegExp(`(?<![A-Za-z0-9])${words.join("[\\s-]+")}(?![A-Za-z0-9])`, "i");
}

/** The named-standard dictionary plus the adopted standards the code does not already name. Built once per call site, not per mention. */
export function entityDictionary(adopted?: Partial<AdoptedVocabulary>): DictEntry[] {
  const entries = adoptedEntries(adopted, "standard");
  if (!entries.length) return [...NAMED_ENTITIES];
  const have = new Set(NAMED_ENTITIES.map((e) => norm(e.canonical)));
  const out = [...NAMED_ENTITIES];
  for (const e of entries) {
    const canonical = e.label || e.key;
    if (have.has(norm(canonical)) || have.has(norm(e.key))) continue;
    have.add(norm(canonical));
    out.push({ canonical, re: adoptedTermRegex(e.key), adopted: true });
  }
  return out;
}

export function detectMentions(text: unknown, adopted?: Partial<AdoptedVocabulary>, dict: readonly DictEntry[] = entityDictionary(adopted)): Mention[] {
  const s = String(text ?? "");
  const out: Mention[] = [];
  // Instrument identifiers by scheme (CELEX, "(EU) 2019/883", a bare 2019/883): a fiscal year such as 2023/24 is a date range, never an identifier.
  const ids = findIdentifiers(s).filter((f) => f.kind === "instrument");
  for (const f of ids) {
    const canonical = f.scheme === "celex" ? f.literal.replace(/^CELEX[:\s]*/i, "") : f.key.replace(/^instrument:/, "");
    out.push({ kind: "identifier", value: canonical, canonical, key: f.key, type: f.type });
  }
  for (const e of dict) if (e.re.test(s)) out.push({ kind: "named", value: e.canonical, canonical: e.canonical });
  for (const raw of s.match(RE_STD_SHAPED) ?? []) {
    const val = raw.trim();
    const isNamed = dict.some((e) => e.re.test(val));
    const isRegnum = findIdentifiers(val).some((f) => f.kind === "instrument");
    if (!isNamed && !isRegnum) out.push({ kind: "shaped", value: val, canonical: val });
  }
  // One mention per instrument: a typeless "2019/883" beside a typed "Directive (EU) 2019/883" is the typed one.
  const typedKeys = new Set(out.filter((m) => m.type).map((m) => m.key));
  return uniqBy(out.filter((m) => m.type || !typedKeys.has(m.key)), (x) => `${x.kind}:${x.key ?? norm(x.canonical)}:${x.type ?? ""}`);
}

/** The identifier a mention names: the one it carries, else the first its value spells (a caller that builds a Mention by hand passes only the text). */
function mentionIdentifier(m: Mention): Pick<Identifier, "key" | "type"> | null {
  if (m.key) return { key: m.key, type: m.type ?? null };
  return findIdentifiers(m.value).find((f) => f.kind === "instrument") ?? null;
}

/**
 * The corpus items a mention names. An identifier mention resolves by EQUALITY on the normalised identifier of the item (its identifier field, else the one its title opens with):
 * 2019/88 never resolves to 2019/883. Items whose text merely CONTAINS the mention come back as `near`, for the surface flag, and are never wired.
 */
export function resolveMention(mention: Mention, corpus: readonly CorpusRow[], excludeId: string | null = null, dict?: readonly DictEntry[]): { ids: string[]; count: number; near: string[] } {
  const pool = (corpus ?? []).filter((c) => c.id !== excludeId);
  let ids: string[] = [];
  let near: string[] = [];
  if (mention.kind === "identifier") {
    const want = mentionIdentifier(mention);
    const v = norm(mention.value);
    ids = want ? pool.filter((c) => ownIdentifiers(c).some((o) => sameIdentifier(o, want))).map((c) => c.id) : pool.filter((c) => norm(c.instrument_identifier) === v).map((c) => c.id);
    const exact = new Set(ids);
    near = v ? pool.filter((c) => !exact.has(c.id) && (norm(c.title).includes(v) || norm(c.instrument_identifier).includes(v))).map((c) => c.id) : [];
  } else if (mention.kind === "named") {
    const e = (dict ?? NAMED_ENTITIES).find((x) => x.canonical === mention.canonical);
    if (e) ids = pool.filter((c) => e.re.test(String(c.title ?? "")) || e.re.test(String(c.instrument_identifier ?? ""))).map((c) => c.id);
  } else {
    const v = norm(mention.value);
    ids = pool.filter((c) => norm(c.title).includes(v)).map((c) => c.id);
  }
  const set = new Set(ids);
  return { ids: [...set], count: set.size, near };
}

/** Exactly one resolved item for an identifier or a named entity is wired; ambiguous, unmatched or shaped-unknown mentions are surfaced, never guessed. */
export const classifyBucket = (mention: Pick<Mention, "kind">, resolvedCount: number): "wire" | "surface" => ((mention.kind === "identifier" || mention.kind === "named") && resolvedCount === 1 ? "wire" : "surface");

const RE_IMPLEMENTS = /\b(implementing|application of)\b/i;
const RE_SELF_IMPLEMENTING_TITLE = /^\s*commission implementing\b/i;
const RE_AMENDS = /\bamending\b/i;
const RE_SUPPLEMENTS_DELEGATED = /\b(supplementing|delegated)\b/i;
const RE_AUTHORISES = /\bauthoris/i;
const RE_IN_ACCORDANCE = /\bin accordance with\b/i;
const LINEAGE_WINDOW = 200;

export interface LineageBasis {
  signal: string;
  detail: string;
  weight: number;
}
export interface Typed {
  relationship: "depends_on" | "amends" | "implements" | "related";
  basis: LineageBasis[] | null;
}

function windowAroundMention(content: unknown, mention: string): string {
  const text = String(content ?? "");
  if (!mention) return text;
  const at = indexOfInsensitive(text, mention);
  return at === null ? text : text.slice(Math.max(0, at.index - LINEAGE_WINDOW), Math.min(text.length, at.index + at.length + LINEAGE_WINDOW));
}

/** The lineage relationship the sentence around a mention states (derogation and supplement are depends_on; no cue stays related). */
export function classifyRelationship(content: unknown, mentionCanonical: string, selfTitle: unknown): Typed {
  const near = windowAroundMention(content, mentionCanonical);
  const title = String(selfTitle ?? "");
  const lineage = (detail: string): LineageBasis[] => [{ signal: "lineage", detail, weight: 0 }];
  if (RE_AUTHORISES.test(near) && RE_IN_ACCORDANCE.test(near)) return { relationship: "depends_on", basis: lineage(`derogates under ${mentionCanonical}`) };
  if (RE_AMENDS.test(near)) return { relationship: "amends", basis: lineage(`amends ${mentionCanonical}`) };
  if (RE_SUPPLEMENTS_DELEGATED.test(near)) return { relationship: "depends_on", basis: lineage(`supplements ${mentionCanonical}`) };
  if (RE_IMPLEMENTS.test(near) || RE_SELF_IMPLEMENTING_TITLE.test(title)) return { relationship: "implements", basis: lineage(`implements ${mentionCanonical}`) };
  return { relationship: "related", basis: null };
}

export interface PlannedLinks {
  edges: { target_item_id: string; via: string; kind: string; relationship: Typed["relationship"]; basis: LineageBasis[] | null }[];
  surface: { mention: string; kind: string; resolvedCount: number; near: number }[];
  lineageGaps: { mention: string; relationship: string }[];
}

export function planLinks(content: string, corpus: readonly CorpusRow[], selfId: string, adopted?: Partial<AdoptedVocabulary>): PlannedLinks {
  const selfRow = corpus.find((c) => c.id === selfId);
  const selfTitle = selfRow?.title ?? "";
  const selfIds = selfRow ? ownIdentifiers(selfRow) : [];
  const dict = entityDictionary(adopted);
  const edges: PlannedLinks["edges"] = [];
  const surface: PlannedLinks["surface"] = [];
  const lineageGaps: PlannedLinks["lineageGaps"] = [];
  for (const m of detectMentions(content, adopted, dict)) {
    const r = resolveMention(m, corpus, selfId, dict);
    if (classifyBucket(m, r.count) === "wire") {
      let relationship: Typed["relationship"] = "related";
      let basis: LineageBasis[] | null = null;
      if (m.kind === "identifier") {
        const typed = classifyRelationship(content, m.canonical, selfTitle);
        relationship = typed.relationship;
        basis = typed.basis;
      }
      edges.push({ target_item_id: r.ids[0] as string, via: m.canonical, kind: m.kind, relationship, basis });
    } else {
      surface.push({ mention: m.canonical, kind: m.kind, resolvedCount: r.count, near: r.near.length });
      const isSelf = m.kind === "identifier" && selfIds.some((o) => sameIdentifier(o, { key: m.key ?? "", type: m.type ?? null }));
      if (m.kind === "identifier" && r.count === 0 && !isSelf) {
        const typed = classifyRelationship(content, m.canonical, selfTitle);
        if (typed.relationship !== "related") lineageGaps.push({ mention: m.canonical, relationship: typed.relationship });
      }
    }
  }
  return { edges: uniqBy(edges, (e) => e.target_item_id), surface, lineageGaps: uniqBy(lineageGaps, (g) => g.mention) };
}

/** A URL on one canonical spelling (the one in @/core/parse: https, host without www, path and query case kept, query sorted, no fragment or tracking parameters). Unparseable input comes back as it was. */
export function canonicalSubjectUrl(rawUrl: string): string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return rawUrl;
  return canonicalizeUrl(rawUrl) ?? rawUrl;
}

type How = "instrument_identifier" | "source_url" | "reg_number";
/** Existing corpus items that are the same subject as a candidate: same instrument identifier, same canonical URL, or the same own registration number (equality on the normalised identifier). */
export function matchExistingSubject(item: CorpusRow, corpus: readonly CorpusRow[]): { id: string; how: How }[] {
  const instr = norm(item.instrument_identifier);
  const url = item.source_url ? canonicalSubjectUrl(String(item.source_url)) : "";
  const regs = ownIdentifiers(item);
  const out: { id: string; how: How }[] = [];
  for (const c of corpus) {
    if (item.id && c.id === item.id) continue;
    if (instr && norm(c.instrument_identifier) === instr) out.push({ id: c.id, how: "instrument_identifier" });
    else if (url && c.source_url && canonicalSubjectUrl(String(c.source_url)) === url) out.push({ id: c.id, how: "source_url" });
    else if (regs.length && ownIdentifiers(c).some((o) => regs.some((r) => sameIdentifier(o, r)))) out.push({ id: c.id, how: "reg_number" });
  }
  return out;
}

export const LINK_ALLOWED_TABLES: readonly string[] = ["item_cross_references", "integrity_flags"];
export interface LinkWrite {
  table: string;
  row: Record<string, unknown>;
}
/** The link step writes edges and flags and nothing else: grounding citations stay reserved for the primary instrument. */
export function assertMoatBoundary(writes: readonly { table: string }[]): void {
  const bad = writes.filter((w) => !LINK_ALLOWED_TABLES.includes(w.table));
  if (bad.length) throw new Error(`moat boundary violated: linkStep may write ONLY ${LINK_ALLOWED_TABLES.join("/")}, got [${bad.map((w) => w.table).join(", ")}]`);
}

/** The writes a content scan plans: typed edges (origin entity_extraction), one surface flag, one lineage-gap flag. */
export function planLinkWrites(content: string, corpus: readonly CorpusRow[], itemId: string, adopted?: Partial<AdoptedVocabulary>): LinkWrite[] {
  const { edges, surface, lineageGaps } = planLinks(content, corpus, itemId, adopted);
  const writes: LinkWrite[] = edges.map((e) => ({
    table: "item_cross_references",
    row: { source_item_id: itemId, target_item_id: e.target_item_id, relationship: e.relationship, origin: "entity_extraction", ...(e.basis ? { basis: e.basis } : {}) },
  }));
  if (surface.length) {
    writes.push({
      table: "integrity_flags",
      row: {
        category: "data_quality", subject_type: "item", subject_ref: itemId,
        description: `Entity mentions needing review (ambiguous / unknown-standard): ${surface.map((s) => `${s.mention}(${s.resolvedCount}${s.near ? `, ${s.near} near` : ""})`).join(", ")}`.slice(0, 480),
        recommended_actions: surface.slice(0, 20).map((s) => ({ action: "review_entity_mention", rationale: `${s.kind}:${s.mention} resolved to ${s.resolvedCount} item(s)` })),
        status: "open", created_by: "intake-entity-link",
      },
    });
  }
  if (lineageGaps.length) {
    writes.push({
      table: "integrity_flags",
      row: {
        category: "coverage_gap", subject_type: "item", subject_ref: itemId,
        description: `Enabling/parent instrument(s) named but absent from the corpus: ${lineageGaps.map((g) => `${g.mention} (${g.relationship})`).join(", ")}`.slice(0, 480),
        recommended_actions: lineageGaps.slice(0, 20).map((g) => ({ action: "acquire_parent_instrument", rationale: `item ${g.relationship} ${g.mention}, which does not resolve to any item in the corpus` })),
        status: "open", created_by: "lineage-gap:absent-parent",
      },
    });
  }
  assertMoatBoundary(writes);
  return writes;
}
