// New in SYNTH-FIX-1 (B2, B3): the grounding pre-check every analysis kind runs before the second reader. Containment against the evidence, not a word list (ADR-053/054): every numeric literal, every count word mapped to its number and every acronym or
// TitleCase term an analysis states must occur verbatim (numbers: as the same normalised number) in the cited rows' stored values or the cited captures. A gap is held to the same test (it may not name what no capture holds) and a gap whose every
// figure and term a cited capture already holds is contradicted by it. The count words are a numeral map (digits spelled out), not a vocabulary of meaning. Pure.
const COUNTS: Readonly<Record<string, number>> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100 };
const COUNT_RE = new RegExp(String.raw`\b(${Object.keys(COUNTS).join("|")})\b(?!-[A-Z])`, "gi");
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const ACRONYM_RE = /\b(?:[a-z]+-)?[A-Z]{2,}[A-Z0-9-]*\b/g;
const TITLE_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const STRUCTURE = new Set(["confirmed", "hypothesis", "refuted", "fact", "gap", "analysis"]);
const num = (s: string): string => String(Number(s.replace(/,/g, "")));
/** What is not a claim of the text: citations, ids, source lines (a url), a table's header row, list markers. */
const stripped = (t: string, ignore: readonly string[]): string => ignore.reduce((x, s) => x.split(s).join(" "), t).replace(/\[[a-z_]+:[^\]\s]+\]|^.*https?:\/\/.*$|^\|[^\n]*\n\|[ \t:|-]+$|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\s*\d+[.)]\s/gim, " ");

export interface Token { kind: "number" | "percent" | "count" | "term"; text: string; value?: string }
/** The checkable tokens of a text: numbers (with a percent sign kept), count words, acronyms and TitleCase terms (a sentence-initial word is not part of a term). */
function tokensOf(raw: string, ignore: readonly string[] = []): Token[] {
  const t = stripped(raw, ignore);
  const out: Token[] = [];
  for (const m of t.matchAll(new RegExp(String.raw`(${NUM_RE.source})(\s?(?:%|per ?cent))?`, "gi"))) out.push({ kind: m[2] ? "percent" : "number", text: m[0].trim(), value: num(m[1] as string) });
  for (const m of t.matchAll(COUNT_RE)) if (m[0] !== m[0].toUpperCase()) out.push({ kind: "count", text: m[0], value: String(COUNTS[m[0].toLowerCase()]) });
  for (const m of t.matchAll(ACRONYM_RE)) if (!STRUCTURE.has(m[0].toLowerCase())) out.push({ kind: "term", text: m[0].replace(/-+$/, "") });
  for (const m of t.matchAll(TITLE_RE)) {
    const initial = /(^|[.!?:;(\n]\s*|[-*#>]\s*)$/.test(t.slice(0, m.index));
    const words = m[0].split(/\s+/).slice(initial ? 1 : 0);
    if (words.length >= 2) out.push({ kind: "term", text: words.join(" ") });
  }
  return out;
}

const flat = (xs: readonly string[]): string => xs.join(String.fromCharCode(10)).replace(/&nbsp;|&#160;|[\u00a0\u202f]/g, " ").replace(/&amp;/g, "&").toLowerCase();
const numbersOf = (t: string): Set<string> => new Set([...t.matchAll(NUM_RE)].map((m) => num(m[0])));
/** What holds a token. A term: its text in the evidence. A percent: the number followed by a percent sign. A number: the normalised number in the evidence. A count word: the word itself in the evidence, one of the entry's own structural counts, or the number in a cited row's STORED VALUE
 * (`values`; a numeral of capture prose, a date part or a recital number, does not count a thing). */
const heldIn = (evidence: readonly string[], counts: readonly number[], values: readonly string[]) => {
  const ev = flat(evidence);
  const [numbers, stored] = [numbersOf(ev), numbersOf(flat(values))];
  const percents = new Set([...ev.matchAll(new RegExp(String.raw`(${NUM_RE.source})\s?(?:%|per ?cent)`, "g"))].map((m) => num(m[1] as string)));
  const own = new Set(counts.map(String));
  return (k: Token): boolean => (k.kind === "term" ? ev.includes(k.text.toLowerCase()) : k.kind === "percent" ? percents.has(k.value as string) : k.kind === "count" ? own.has(k.value as string) || stored.has(k.value as string) || ev.includes(k.text.toLowerCase()) : numbers.has(k.value as string) || own.has(k.value as string));
};

/** The refusals of the pre-check: each names the token and where it was stated. `counts` are the structural counts the entry may state (rows, surfaces, items); `ignore` are fixed strings (headings, callouts) that are not claims. */
export function groundingReasons(o: { texts: Record<string, string>; gaps?: readonly string[]; evidence: readonly string[]; /** the cited rows' stored values (default: the evidence) */ values?: readonly string[]; counts?: readonly number[]; ignore?: readonly string[] }): string[] {
  const held = heldIn(o.evidence, o.counts ?? [], o.values ?? o.evidence);
  const phrasing = flat(o.evidence).replace(/\s+/g, " ");
  const numbers = numbersOf(phrasing);
  const seen = new Set<string>();
  const out: string[] = [];
  const miss = (where: string, text: string) => { for (const k of tokensOf(text, o.ignore)) if (!held(k) && !seen.has(`${where}|${k.text}`)) { seen.add(`${where}|${k.text}`); out.push(`grounding pre-check: ${where} states ${k.kind} ${JSON.stringify(k.text)}, which occurs in no cited row value or cited capture`); } };
  for (const [where, text] of Object.entries(o.texts)) miss(where, text);
  (o.gaps ?? []).forEach((g, i) => {
    // a gap names what the evidence does NOT hold, so it is exempt from containment. It is contradicted only by (a) a figure it states as missing (a number with a unit or percent sign, a bare year excepted) held as the same normalised number, or (b) its whole missing_input phrase verbatim in a capture; a context token alone (an acronym, a name, a year) is no contradiction
    const figures = [...g.matchAll(new RegExp(String.raw`(${NUM_RE.source})\s?(%|per ?cent|[A-Za-z]{1,12})`, "g"))].filter((m) => m[2] === "%" || /^per ?cent$/i.test(m[2] as string) || !(Number(m[1]) > 1899 && Number(m[1]) < 2101)).map((m) => m[0].trim()).filter((f) => numbers.has(num(f.match(NUM_RE)?.[0] ?? "")));
    const phrase = g.replace(/\s+/g, " ").trim().toLowerCase();
    if (figures.length || (phrase && phrasing.includes(phrase))) out.push(`gap contradiction: coverage_gaps[${i}] asks for ${JSON.stringify(g.slice(0, 120))}, but ${figures.length ? `its figure ${figures.join(", ")} is` : "the whole phrase is"} already held by a cited capture or row`);
  });
  return out;
}

/** The signposts (each as one text) and the coverage-gap inputs an entry carries, read as stated (a malformed element is the write-back verifier's refusal, not this check's). */
export function writebackOf(e: Record<string, unknown>): { texts: Record<string, string>; gaps: string[] } {
  const list = (k: string): Record<string, unknown>[] => (Array.isArray(e[k]) ? (e[k] as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const s = (x: unknown): string => (typeof x === "string" ? x : "");
  return {
    texts: Object.fromEntries(list("signposts").map((x, i) => [`signposts[${i}]`, [x.claim_text, x.observable, x.confirms_if, x.falsified_if].map(s).join(String.fromCharCode(10))])),
    gaps: list("coverage_gaps").map((g) => s(g.missing_input)).filter(Boolean),
  };
}
