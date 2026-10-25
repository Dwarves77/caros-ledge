// DERIVE-2 V1: the transport mode(s) a verbatim span names, or, when no span rule matches, its instrument's title and identifier (the instrument's scope applies to every obligation in it). The rules are data (object-rules.json modeClassifiers,
// zod-validated here at import, every mode token checked against the transport_mode vocabulary); the function is pure and returns the tokens, the rule ids and the input that matched. No match is no mode: never a default.
import { z } from "zod";

import { LEG_MODE_CODES } from "@/core/contracts/vocabularies";

import rulesJson from "./data/object-rules.json";

const classifier = z.object({ id: z.string().min(1), pattern: z.string().min(1), modes: z.array(z.string()).min(1), on: z.enum(["span", "instrument"]), consignment_wide: z.boolean().optional() });
export const MODE_CLASSIFIERS = z.array(classifier).min(1).parse(rulesJson.modeClassifiers).map((c) => ({ ...c, re: new RegExp(c.pattern, "i") }));
for (const c of MODE_CLASSIFIERS) {
  const alien = c.modes.find((m) => !LEG_MODE_CODES.includes(m));
  if (alien) throw new Error(`object-rules.json modeClassifiers "${c.id}": "${alien}" is not a leg mode of the transport_mode vocabulary`);
  if (c.consignment_wide && LEG_MODE_CODES.some((m) => !c.modes.includes(m))) throw new Error(`object-rules.json modeClassifiers "${c.id}": a consignment-wide rule names every leg mode`);
}

export interface ModeVerdict {
  /** Leg modes in vocabulary order; empty when no rule matched. */
  modes: string[];
  ruleIds: string[];
  /** Where the winning rules read: the span, the instrument (a title-only match, counted apart), or nowhere. */
  from: "span" | "instrument" | null;
  /** The text each matching rule matched. */
  matched: string[];
  consignmentWide: boolean;
}

export function classifyMode(span: string, instrument: { title?: string | null | undefined; identifier?: string | null | undefined }): ModeVerdict {
  const read = (on: "span" | "instrument", text: string) => MODE_CLASSIFIERS.filter((c) => c.on === on).flatMap((c) => { const m = c.re.exec(text); return m ? [{ c, matched: m[0] }] : []; });
  const fromSpan = read("span", span);
  const hits = fromSpan.length ? fromSpan : read("instrument", `${instrument.title ?? ""} ${instrument.identifier ?? ""}`);
  return { modes: LEG_MODE_CODES.filter((m) => hits.some((h) => h.c.modes.includes(m))), ruleIds: hits.map((h) => h.c.id), from: fromSpan.length ? "span" : hits.length ? "instrument" : null, matched: hits.map((h) => h.matched), consignmentWide: hits.some((h) => h.c.consignment_wide === true) };
}
