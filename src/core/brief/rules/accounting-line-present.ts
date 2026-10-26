// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 548-1051)
// R13 (V24), VALID-1: a regulatory fact document ends "Substantive Requirements" with the depth-accounting line ("Obligations surveyed: N; workspace-adjacent: N; extracted as FACT: N.") and its Shortfall line, and accounts for each qualification. This is mirrors d and e of the item-briefs validator, moved here so the registry is its one owner.
import { FORMATS } from "../contract";

import { violation } from "./_text";
import type { BriefClaim, Rule } from "./types";

const LARGE_POOL_CHARS = 200_000;
export const ACCOUNTING_RE = /Obligations surveyed:\s*(\d+);\s*workspace-adjacent:\s*(\d+);\s*extracted as FACT:\s*(\d+)\.?/i;
const SHORTFALL_RE = /^Shortfall:\s*\S.*$/im;
const NEGATION_RE = /\b(no|not|none|never|nor)\b/i;
const NEGATION_WINDOW = 24;
// Small named stem lists with their inflections, matched on a claim's own verbatim span behind the negation guard.
const EXCEPTION_RE = /\b(exempt|exempts|exempted|exemption|exemptions|except|carve-?out|condition|conditions|conditional|subject to)\b/i;
const SCOPE_RE = /\b(scope|applies to|applies only|does not apply|limited to)\b/i;
const TRAJECTORY_RE = /\b(phase|phased|phase-in|per year|from \d{4})\b/i;
const CITE = "(?:articles?|sections?)\\s+[^.\\n]+";
const ABSENCE = { trajectory: new RegExp(`\\bno phase-in (?:is|are) stated in ${CITE}\\.`, "i"), exceptions: new RegExp(`\\bno exceptions? (?:is|are) stated in ${CITE}\\.`, "i"), scope: new RegExp(`\\bno scope limits? (?:is|are) stated in ${CITE}\\.`, "i") };

/** An unnegated hit of `re` in some claim's own span (a window of words before the match carries no negation). */
function unnegatedHit(claims: readonly BriefClaim[], re: RegExp): boolean {
  return claims.some((c) => {
    const span = c.span ?? "";
    const m = re.exec(span);
    return !!m && !NEGATION_RE.test(span.slice(Math.max(0, m.index - NEGATION_WINDOW), m.index));
  });
}

const rule: Rule = (b, item) => {
  const key = FORMATS.find((f) => f.formatType === b.format)?.sections.find((s) => s.heading === "Substantive Requirements")?.key;
  const req = key ? b.sections.get(key) : undefined;
  const msgs: string[] = [];
  const at = (m: string) => void msgs.push(m);
  if (!req || !key) at('depth accounting: "Substantive Requirements" is not present (or has no extractable content) -- required for every regulatory_fact_document entry');
  else {
    const attached = b.claims.filter((c) => c.kind === "FACT" && c.section === key);
    const acc = ACCOUNTING_RE.exec(req);
    if (!acc) at('depth accounting: "Substantive Requirements" must end with the line "Obligations surveyed: N; workspace-adjacent: M; extracted as FACT: K." -- missing');
    else {
      const [adjacent, extracted] = [Number(acc[2]), Number(acc[3])];
      const shortfall = SHORTFALL_RE.test(req);
      if (extracted > attached.length) at(`depth accounting: "extracted as FACT: ${extracted}" overstates the ${attached.length} FACT claim(s) attached to section ${JSON.stringify(key)}`);
      if (extracted < adjacent && !shortfall) at(`depth accounting: "extracted as FACT: ${extracted}" is less than "workspace-adjacent: ${adjacent}" with no "Shortfall: <reason>" line`);
      if ((item.pool_chars ?? 0) > LARGE_POOL_CHARS && extracted < 5 && !shortfall) at(`depth accounting: source pool is ${item.pool_chars} chars (over ${LARGE_POOL_CHARS}) and "extracted as FACT: ${extracted}" is under 5 with no "Shortfall: <reason>" line`);
      const tail = req.slice(acc.index + acc[0].length).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !SHORTFALL_RE.test(l));
      if (tail.length) at(`depth accounting: content follows the accounting line inside "Substantive Requirements" (${JSON.stringify(tail[0])}${tail.length > 1 ? ", ..." : ""}) -- the accounting line (and any Shortfall line) must be the end of the section`);
    }
    if (!(item.has_trajectory || unnegatedHit(attached, TRAJECTORY_RE)) && !ABSENCE.trajectory.test(req)) at('qualification accounting: no per-year trajectory captured (metadata.requirement_trajectory or a FACT span) and no "No phase-in is stated in Article(s)/Section(s) <range>." note');
    if (!unnegatedHit(attached, EXCEPTION_RE) && !ABSENCE.exceptions.test(req)) at(`qualification accounting: no unnegated exception/carve-out keyword in the span of a FACT claim attached to section ${JSON.stringify(key)}, and no "No exceptions are stated in Article(s)/Section(s) <range>." note`);
    if (!unnegatedHit(attached, SCOPE_RE) && !ABSENCE.scope.test(req)) at(`qualification accounting: no unnegated scope-limit keyword in the span of a FACT claim attached to section ${JSON.stringify(key)}, and no "No scope limits are stated in Article(s)/Section(s) <range>." note`);
  }
  return msgs.length ? violation("accounting-line-present", msgs.join("; "), msgs[0] as string) : null;
};
export default rule;
