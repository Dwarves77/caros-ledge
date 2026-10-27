// Ported from old_repo/src/lib/detail/fact-paragraphs.ts (lines 1-161)
// Ported from old_repo/src/lib/detail/fact-card-model.ts (lines 1-478)
// A fact-document section's markdown to the fact-card models the kit draws: paragraph classes, lead-in kinds, embedded sentences, provenance, claim nodes, the figure lead, same-kind
// merging, and the record-grade model. One regex set (the old tree kept two). The tier read itself (withClaimTiers, by claim id) is the kit's, re-exported by the barrel.
import { claimIdOfParagraph, stripClaimLedgerBlocks, withoutClaimMarker } from "@/core/brief";
import { hostOf } from "@/core/shared";
import type { ClaimNode, FactCardModel } from "@/ui";

type ParagraphKind = "fact" | "inference" | "counsel" | "prose";
export interface ParsedSource {
  title: string | null;
  issuer: string | null;
  date: string | null;
  url: string | null;
}
export interface FactParagraph {
  kind: ParagraphKind;
  text: string;
  source?: ParsedSource | null;
  label?: string | null;
  /** The grounded claim the paragraph states, when the surface binds one (section_claim_provenance.id). */
  claimId?: string | null;
}

const ANALYSIS: Array<{ token: string; humanized: string }> = [
  { token: "Analytical inference:", humanized: "Analytical inference" },
  { token: "Industry interpretation:", humanized: "Industry interpretation" },
  { token: "Operational implication:", humanized: "Operational implication" },
];
const LEGAL_TOKEN = "Legal Confirmation Required:";
const FACT_TOKEN_RE = /^\*{0,2}\s*(?:[^*\n]{0,120}?\s+[—–-]\s+)?FACT:\s*\*{0,2}\s*/i;
const SOURCE_MARK_RE = /\*?\s*Source:\s*/gi;
/** The paragraph's citation: the LAST "Source:" marker to the end (a paragraph that quotes several people, each with its own "Source:" line, once made everything after the first marker one citation: a 40-line provenance column). */
function sourceCitation(text: string): { index: number; citation: string } | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(SOURCE_MARK_RE)) last = m;
  if (!last) return null;
  const citation = text.slice(last.index + last[0].length).replace(/\*?\s*$/, "");
  return citation.trim() ? { index: last.index, citation } : null;
}
const URL_RE = /https?:\/\/[^\s)\]}"'<>]+/;
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function unwrapOuterQuotes(text: string): string {
  const t = text.trim();
  for (const [open, close] of [['"', '"'], ["“", "”"]] as const) {
    if (t.length >= 2 && t.startsWith(open) && t.endsWith(close)) {
      const inner = t.slice(1, -1);
      if (!inner.includes(open) && !inner.includes(close)) return inner.trim();
    }
  }
  return t;
}
const stripFactLabel = (text: string): string => unwrapOuterQuotes(text.replace(FACT_TOKEN_RE, "").trim());

function stripLeadingEmphasisToken(text: string, token: string): string | null {
  const re = new RegExp(`^\\*{1,2}\\s*${escapeRe(token)}\\s*\\*{0,2}\\s*`, "i");
  return re.test(text) ? text.replace(re, "").trim() : null;
}

/** A trailing "Source: Title, Issuer, Date https://..." citation to its parts. */
function parseSourceCitation(raw: string): ParsedSource {
  let rest = raw.trim().replace(/\.$/, "");
  const urlMatch = URL_RE.exec(rest);
  const url = urlMatch ? urlMatch[0].replace(/[.,;:]+$/, "") : null;
  if (urlMatch) rest = (rest.slice(0, urlMatch.index) + rest.slice(urlMatch.index + urlMatch[0].length)).trim();
  const parts = rest.replace(/[.,]\s*$/, "").trim().split(",").map((p) => p.trim()).filter(Boolean);
  return { title: parts[0] ?? null, issuer: parts.length > 2 ? parts.slice(1, -1).join(", ") : parts.length === 2 ? (parts[1] ?? null) : null, date: parts.length > 1 ? (parts[parts.length - 1] ?? null) : null, url };
}

function classifyParagraph(paragraph: string): FactParagraph {
  const text = paragraph.trim();
  for (const { token, humanized } of ANALYSIS) {
    const rest = stripLeadingEmphasisToken(text, token);
    if (rest !== null) return { kind: "inference", text: rest, label: humanized };
  }
  const legal = stripLeadingEmphasisToken(text, LEGAL_TOKEN);
  if (legal !== null) return { kind: "counsel", text: legal };
  const m = sourceCitation(text);
  const before = m ? text.slice(0, m.index).trim() : "";
  return m && before ? { kind: "fact", text: stripFactLabel(before), source: parseSourceCitation(m.citation) } : { kind: "prose", text };
}

/** A section's markdown to classified paragraphs; the claim-ledger blocks never reach a customer. A paragraph that names its claim (`<!-- claim:<uuid> -->` on its first line, core/brief/claim-marker.ts) carries the id; one that does not carries none. */
export function parseFactParagraphs(markdown: string | null | undefined): FactParagraph[] {
  const md = stripClaimLedgerBlocks(markdown);
  if (!md.trim()) return [];
  return md.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((p) => {
    const claimId = claimIdOfParagraph(p);
    return { ...classifyParagraph(withoutClaimMarker(p).trim()), ...(claimId ? { claimId } : {}) };
  });
}

const LEAD_IN_KINDS = ["ACTION REQUIRED", "LEGAL CONFIRMATION REQUIRED", "DEADLINE", "BASELINE TARGET", "NATIONAL TARGET", "SCOPE", "PENALTY", "DEFINITION"] as const;
const LEAD_IN_RE = new RegExp(`^["'“]?\\s*\\*{1,2}\\s*(${[...LEAD_IN_KINDS].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})\\s*[.:]?\\s*\\*{0,2}\\s*`, "i");
const IMPERATIVE_LEADS = ["Register", "Confirm", "Ask", "Budget", "File", "Request", "Map"];
const EMBEDDED_SPLIT_RE = /(?:\*{1,2}\s*)?(Legal Confirmation Required|Analytical inference|Industry interpretation|Operational implication)\s*:\s*(?:\*{0,2}\s*)?/gi;
const HUMANIZED: Record<string, string> = { "legal confirmation required": "Legal Confirmation Required", "analytical inference": "Analytical inference", "industry interpretation": "Industry interpretation", "operational implication": "Operational implication" };
type Kind = FactCardModel["kind"];
interface Piece {
  kind: Kind | null;
  qualifier?: string | null;
  text: string;
}

function splitEmbeddedSentences(text: string): Piece[] {
  const matches = [...text.matchAll(EMBEDDED_SPLIT_RE)];
  const first = matches[0];
  if (!first) return [{ kind: null, text }];
  const pieces: Piece[] = [];
  const before = text.slice(0, first.index).trim();
  if (before) pieces.push({ kind: null, text: before });
  matches.forEach((m, i) => {
    const humanized = HUMANIZED[(m[1] ?? "").toLowerCase()];
    const kind = humanized === "Legal Confirmation Required" ? "LEGAL CONFIRMATION REQUIRED" : "ANALYTICAL INFERENCE";
    pieces.push({ kind, qualifier: kind === "ANALYTICAL INFERENCE" ? (humanized ?? null) : null, text: text.slice(m.index + m[0].length, matches[i + 1]?.index ?? text.length).trim() });
  });
  return pieces;
}

function extractProvenance(text: string): { text: string; provenance: FactCardModel["provenance"] } {
  const source = sourceCitation(text);
  if (source) {
    const parsed = parseSourceCitation(source.citation);
    return { text: text.slice(0, source.index).trim(), provenance: { source: parsed.title, org: parsed.issuer, accessed: parsed.date, href: parsed.url, tier: null } };
  }
  const link = MD_LINK_RE.exec(text);
  if (link) return { text: (text.slice(0, link.index) + link[1] + text.slice(link.index + link[0].length)).trim(), provenance: { href: link[2] ?? null, source: hostOf(link[2]), org: null, accessed: null, tier: null } };
  const url = URL_RE.exec(text);
  if (url) return { text: (text.slice(0, url.index) + text.slice(url.index + url[0].length)).trim(), provenance: { href: url[0], source: hostOf(url[0]), org: null, accessed: null, tier: null } };
  return { text, provenance: null };
}

const stripAsterisks = (s: string) => s.replace(/\*/g, "").trim();
function splitEmbeddedLinks(node: ClaimNode): ClaimNode[] {
  const parts: ClaimNode[] = [];
  let last = 0;
  for (const m of node.text.matchAll(new RegExp(URL_RE.source, "g"))) {
    if (m.index > last) parts.push({ text: node.text.slice(last, m.index), ...(node.bold ? { bold: true } : {}) });
    parts.push({ text: hostOf(m[0]), href: m[0] });
    last = m.index + m[0].length;
  }
  if (parts.length === 0) return [node];
  if (last < node.text.length) parts.push({ text: node.text.slice(last), ...(node.bold ? { bold: true } : {}) });
  return parts.filter((n) => n.text.length > 0);
}

/** Markdown to claim nodes: bold runs and embedded links kept, headings, backticks, list markers and stray asterisks gone. */
function toClaimNodes(raw: string): ClaimNode[] {
  const text = raw.replace(/^\s*#{1,6}\s*/, "").replace(/`+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^[ \t]*[-*]\s+/, "").replace(/\n[ \t]*[-*]\s+/g, " ").replace(/\s*\n+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim().replace(/^(\*\*)?([a-z])/, (_, p, c) => (p ?? "") + c.toUpperCase());
  const nodes: ClaimNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (m.index > last) nodes.push({ text: stripAsterisks(text.slice(last, m.index)) });
    nodes.push({ text: stripAsterisks(m[1] ?? ""), bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push({ text: stripAsterisks(text.slice(last)) });
  return nodes.filter((n) => n.text.length > 0).flatMap(splitEmbeddedLinks);
}

// A figure lead is a quantity or a date (it opens with a digit or a currency or comparison sign) and short; a bold sentence or a name that holds a digit ("California SB 343") is not one (P2-15e: they filled the 132 px lead column).
const FIGURE_RE = /^[\d€$£~<>≈+-]/;
const FIGURE_MAX = 24;
function figureLeadFor(kind: Kind, claim: ClaimNode[]): string | null {
  if (kind === "ANALYTICAL INFERENCE") return null;
  const figure = claim.find((n) => n.bold && FIGURE_RE.test(n.text) && n.text.length <= FIGURE_MAX);
  if (figure) return figure.text;
  if (kind !== "ACTION REQUIRED" && kind !== "LEGAL CONFIRMATION REQUIRED") return null;
  const first = claim.map((n) => n.text).join(" ").trim().split(/\s+/)[0]?.replace(/[.,:;]$/, "") ?? "";
  return IMPERATIVE_LEADS.find((v) => v.toLowerCase() === first.toLowerCase()) ?? null;
}

function paragraphToPieces(p: FactParagraph): Array<{ kind: Kind; qualifier: string | null; text: string }> {
  if (p.kind === "prose") return [];
  const base: Kind = p.kind === "counsel" ? "LEGAL CONFIRMATION REQUIRED" : p.kind === "inference" ? "ANALYTICAL INFERENCE" : "SCOPE";
  const lead = p.kind === "fact" ? LEAD_IN_RE.exec(p.text) : null;
  const leadKind = lead ? LEAD_IN_KINDS.find((k) => k === (lead[1] ?? "").toUpperCase()) : undefined;
  const rest = lead && leadKind ? p.text.slice(lead[0].length).trim() : p.text;
  return splitEmbeddedSentences(rest).map((piece) => ({ kind: piece.kind ?? leadKind ?? base, qualifier: piece.qualifier ?? (p.kind === "inference" ? (p.label ?? null) : null), text: piece.text }));
}

/** One classified paragraph to its fact-card models (a prose paragraph yields none: the section draws it as markdown). */
export function deriveFactCardModels(paragraph: FactParagraph): FactCardModel[] {
  const pieces = paragraphToPieces(paragraph);
  const models: FactCardModel[] = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    const extracted = extractProvenance(piece.text);
    const s = paragraph.kind === "fact" && paragraph.source && pieces.length === 1 ? paragraph.source : null;
    const claim = toClaimNodes(extracted.text);
    if (claim.length === 0) continue;
    models.push({ kind: piece.kind, qualifier: piece.qualifier, figureLead: figureLeadFor(piece.kind, claim), figureSubLabel: null, claim, ...(paragraph.claimId ? { claimId: paragraph.claimId } : {}), provenance: s ? { source: s.title, org: s.issuer, accessed: s.date, href: s.url, tier: null } : (extracted.provenance ?? null) });
  }
  return models;
}

/** Adjacent cards of one kind become one card carrying the later claims, each with its own provenance. */
export function mergeAdjacentSameKind(models: FactCardModel[]): FactCardModel[] {
  const out: FactCardModel[] = [];
  for (const m of models) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === m.kind) prev.additionalClaims = [...(prev.additionalClaims ?? []), { claim: m.claim, ...(m.claimId ? { claimId: m.claimId } : {}), provenance: m.provenance ?? null }];
    else out.push({ ...m });
  }
  return out;
}

const RECORD_SLOT_KIND: Record<string, Kind> = { effective_date: "DEADLINE", primary_deadline: "DEADLINE", due_date: "DEADLINE", penalty_summary: "PENALTY", jurisdictional_scope: "SCOPE" };

/** A record-grade fact to a card: its tier arrives with the row (matched by the exact claim line upstream), so the containment match leaves it alone. */
export function deriveRecordFactCardModel(fact: { slotKey?: string | null; label: string; span: string | null; sourceName?: string | null; sourceUrl?: string | null; tier?: number | null }): FactCardModel | null {
  if (!fact.span) return null;
  return { kind: (fact.slotKey && RECORD_SLOT_KIND[fact.slotKey]) || "SCOPE", qualifier: fact.label, figureLead: null, figureSubLabel: null, claim: toClaimNodes(fact.span), provenance: { source: fact.sourceName ?? null, org: null, href: fact.sourceUrl ?? null, accessed: null, tier: fact.tier ?? null }, recordGrade: true };
}
