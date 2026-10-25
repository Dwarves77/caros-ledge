// DERIVE-2 V2: the statutory maximum and the cost formula a verbatim span states, as the fragment exactly as the span writes it (spec 01 section 3.4: as published, nothing typed, computed or converted). The rules are data (object-rules.json
// statutoryMaximum); every fragment is grounded before it is written: its figure tokens and the fragment itself are re-found in the span (INV-ARM-5), and the same check refuses a session-authored value that paraphrases the span.
import { z } from "zod";

import { statutoryUnit } from "@/core/parse/unit";

import rulesJson from "./data/object-rules.json";

const rule = z.object({ id: z.string().min(1), kind: z.enum(["maximum", "formula"]), pattern: z.string().min(1) });
const MAXIMUM_RULES = z.array(rule).min(1).parse(rulesJson.statutoryMaximum).map((r) => ({ ...r, re: new RegExp(r.pattern, "i") }));

const FIGURE = /\d(?:[\d.,\s]*\d)?/g;
const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The reason `fragment` may not be written to `column` (statutory_maximum or cost_formula) for this span, or null. A maximum states a figure; every figure token of either column is in the span, and so is the fragment. */
export function groundingRefusal(column: "statutory_maximum" | "cost_formula", fragment: string, span: string): string | null {
  const hay = norm(span);
  const tokens = fragment.match(FIGURE) ?? [];
  if (column === "statutory_maximum" && !tokens.length) return "statutory_maximum_figure_missing";
  const absent = tokens.find((t) => !hay.includes(norm(t)));
  if (absent) return `${column}_figure_not_in_span:${absent.trim()}`;
  return hay.includes(norm(fragment)) ? null : `${column}_not_in_span`;
}

export interface StatutoryHit { fragment: string; ruleId: string; /** The unit token of a maximum (null when the map does not know the words); a formula carries none. */ unit: string | null }
export interface StatutoryFinding { maximum: StatutoryHit | null; formula: StatutoryHit | null; refused: string[] }

/** The first grounded fragment of each kind in the span; a fragment the grounding check refuses is named in `refused` and the next rule is tried. */
export function extractStatutory(span: string): StatutoryFinding {
  const refused: string[] = [];
  const first = (kind: "maximum" | "formula"): StatutoryHit | null => {
    for (const r of MAXIMUM_RULES.filter((x) => x.kind === kind)) {
      const fragment = r.re.exec(span)?.[0].trim();
      if (!fragment) continue;
      const why = groundingRefusal(kind === "maximum" ? "statutory_maximum" : "cost_formula", fragment, span);
      if (why) refused.push(why);
      else return { fragment, ruleId: r.id, unit: kind === "maximum" ? statutoryUnit(fragment) : null };
    }
    return null;
  };
  return { maximum: first("maximum"), formula: first("formula"), refused };
}
