// New in VALID-1: R25 (V20): after the title, an H1 is a heading or heading alternate of the format, compared case-insensitively after the title numbering is stripped. The section extractor also folds -ize/-ise; this rule does not, so a British-spelled heading is named.
import { FORMATS } from "../contract";
import { normaliseHeading } from "../sections";

import { violation } from "./_text";
import type { Rule } from "./types";

const bare = (h: string): string => normaliseHeading(h).replace(/^§\s*\d+\s*[.):-]*\s*/, "");
const rule: Rule = (b) => {
  const known = (FORMATS.find((f) => f.formatType === b.format)?.sections ?? []).flatMap((s) => [s.heading, ...(s.headingAlts ?? [])]);
  const stray = [...b.body.matchAll(/^#\s+(.+?)\s*#*\s*$/gm)].slice(1).map((m) => m[1] ?? "").find((h) => !known.some((k) => bare(h).toLowerCase() === normaliseHeading(k).toLowerCase()));
  return stray === undefined ? null : violation("h1-in-section-list", `H1 ${JSON.stringify(stray)} is not a section of ${b.format}`, stray);
};
export default rule;
