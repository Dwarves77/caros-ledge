// New in SYNTH-FIX-1 (B2, B3), narrowed by CONTAIN-FIX-1 (ADR-053): the grounding pre-check every analysis kind runs before the second reader. It checks DIGIT figures only: every digit number or percentage an analysis states must occur as the same normalised numeric literal in the cited rows' stored values or the cited captures (or be one of the entry's own structural counts).
// A gap is contradicted when it claims missing a numeric figure with its unit that the cited evidence holds, or when its whole missing_input phrase occurs verbatim in a capture. No word lists: ungrounded domain terms are judged semantically by the second reader (J15) and structurally by entity_refs. Pure.
const NUM_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
/** A figure: a number (not part of an id: no letter, slash, dot or hyphen before it) with its unit word or percent sign (a date, a number and a month before a year, is no figure); held when the evidence states the same number with the same unit. */
const FIGURE_RE = new RegExp(String.raw`(?<![A-Za-z0-9/.-])(${NUM_RE.source})\s?(%|per ?cent|[A-Za-z]{1,12})(?![A-Za-z0-9]|\s?\d{4})`, "gi");
const stem = (u: string): string => (/^per ?cent$/i.test(u) ? "%" : u.toLowerCase().replace(/s$/, ""));
const num = (s: string): string => String(Number(s.replace(/,/g, "")));
/** What is not a claim of the text: citations, ids, source lines (a url), a table's header row, list markers. */
const stripped = (t: string, ignore: readonly string[]): string => ignore.reduce((x, s) => x.split(s).join(" "), t).replace(/\[[a-z_]+:[^\]\s]+\]|^.*https?:\/\/.*$|^\|[^\n]*\n\|[ \t:|-]+$|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\s*\d+[.)]\s/gim, " ");

export interface Token { kind: "number" | "percent"; text: string; value: string }
/** The checkable tokens of a text: digit numbers, with a percent sign kept. */
function digitsOf(raw: string, ignore: readonly string[] = []): Token[] {
  const t = stripped(raw, ignore);
  return [...t.matchAll(new RegExp(String.raw`(${NUM_RE.source})(\s?(?:%|per ?cent))?`, "gi"))].map((m) => ({ kind: m[2] ? "percent" : "number", text: m[0].trim(), value: num(m[1] as string) }));
}

const flat = (xs: readonly string[]): string => xs.join(String.fromCharCode(10)).replace(/&nbsp;|&#160;|[\u00a0\u202f]/g, " ").replace(/&amp;/g, "&").toLowerCase();
const numbersOf = (t: string): Set<string> => new Set([...t.matchAll(NUM_RE)].map((m) => num(m[0])));
/** What holds a token. A percent: the number followed by a percent sign in the evidence. A number: the normalised number in the evidence, or one of the entry's own structural counts. */
const heldIn = (evidence: readonly string[], counts: readonly number[]) => {
  const ev = flat(evidence);
  const numbers = numbersOf(ev);
  const percents = new Set([...ev.matchAll(new RegExp(String.raw`(${NUM_RE.source})\s?(?:%|per ?cent)`, "g"))].map((m) => num(m[1] as string)));
  const own = new Set(counts.map(String));
  return (k: Token): boolean => (k.kind === "percent" ? percents.has(k.value) : numbers.has(k.value) || own.has(k.value));
};

/** The refusals of the pre-check: each names the token and where it was stated. `counts` are the structural counts the entry may state (rows, surfaces, items); `ignore` are fixed strings (headings, callouts) that are not claims. */
export function groundingReasons(o: { texts: Record<string, string>; gaps?: readonly string[]; evidence: readonly string[]; counts?: readonly number[]; ignore?: readonly string[] }): string[] {
  const held = heldIn(o.evidence, o.counts ?? []);
  const phrasing = flat(o.evidence).replace(/\s+/g, " ");
  const units = new Set([...phrasing.matchAll(FIGURE_RE)].map((m) => `${num(m[1] as string)}|${stem(m[2] as string)}`));
  const seen = new Set<string>();
  const out: string[] = [];
  const miss = (where: string, text: string) => { for (const k of digitsOf(text, o.ignore)) if (!held(k) && !seen.has(`${where}|${k.text}`)) { seen.add(`${where}|${k.text}`); out.push(`grounding pre-check: ${where} states ${k.kind} ${JSON.stringify(k.text)}, which occurs in no cited row value or cited capture`); } };
  for (const [where, text] of Object.entries(o.texts)) miss(where, text);
  (o.gaps ?? []).forEach((g, i) => {
    // a gap names what the evidence does NOT hold, so it is exempt from containment. It is contradicted only by (a) a figure it states as missing (a number with a unit or percent sign, a bare year excepted) held as the same normalised number, or (b) its whole missing_input phrase verbatim in a capture; a context token alone (an acronym, a name, a year) is no contradiction
    const figures = [...g.matchAll(FIGURE_RE)].filter((m) => !(m[2] !== "%" && Number(m[1]) > 1899 && Number(m[1]) < 2101) && units.has(`${num(m[1] as string)}|${stem(m[2] as string)}`)).map((m) => m[0].trim());
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
