// One figure from one cell or sentence, read through the live parser (findFigures): the figure, or a refusal naming why not. A test lens only.
import { findFigures } from "@/core/parse";
import type { ParseOptions, Parsed, Refusal } from "@/core/parse/figure";

export function parseFigure(text: string, opts: ParseOptions = {}): Parsed {
  const t = text.trim();
  const hits = findFigures(t, opts);
  const first = hits[0];
  if (!first) return { refused: true, reason: "no figure with a unit from the closed set", literal: t };
  if (hits.length > 1) return { refused: true, reason: `${hits.length} figures in one cell: parse one figure at a time`, literal: t };
  return first.result;
}
export const isRefusal = (p: Parsed): p is Refusal => "refused" in p;
