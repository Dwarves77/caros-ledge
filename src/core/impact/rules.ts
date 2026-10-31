// New file (scripts/ci/new-files/impact-1.txt): the impact rules as data, validated at load. RULES (data/rules.json) are the thresholds of the score method: they are part of the method, and the method-version gate hashes them with its code. READING
// (data/reading.json, and the absence sentences in core/http/data/sentences.json) is what reads the stored scores: the per-turn bounds of the backlog, the client dimension's bands and the sentence of every absent input; editing it is not editing the method. No number or sentence is in code.
import { z } from "zod";

import sentencesJson from "@/core/http/data/sentences.json";

import readingJson from "./data/reading.json";
import rulesJson from "./data/rules.json";

const INPUTS = ["obligations", "cost", "operational"] as const;
/** The inputs a stored dimension can be waiting for, in the order a row names the first. */
export type ImpactInputName = (typeof INPUTS)[number];

export const RULES = z
  .object({
    horizonDays: z.number().int().positive(),
    nonBinding: z.array(z.string()),
    costSeverities: z.array(z.string()),
    dueFields: z.array(z.string()).min(1),
    inForceFields: z.array(z.string()),
    operationalRoles: z.array(z.string()).min(1),
    operationalSignalsForThree: z.number().int().positive(),
  })
  .strict()
  .parse(rulesJson);

const READING_FILE = z
  .object({
    client: z.object({ noRelevanceStatus: z.string(), bands: z.object({ low: z.number(), medium: z.number(), high: z.number() }) }),
    backlog: z.object({ scanPerTurn: z.number().int().positive(), scorePerTurn: z.number().int().positive() }),
  })
  .strict()
  .parse(readingJson);
/** The sentence of every absent input is in the one sentence table (core/http/data/sentences.json, "impactAbsence"). */
const ABSENCE = z.object({ obligations: z.string().min(1), cost: z.string().min(1), operational: z.string().min(1), client: z.string().min(1), due: z.string().min(1) }).strict().parse(sentencesJson.impactAbsence);
export const READING = { ...READING_FILE, absence: ABSENCE };

/** The missing input a row names first (the order of the stored dimensions), or null when none is missing. */
export const firstMissing = (missing: readonly string[]): ImpactInputName | null => INPUTS.find((i) => missing.includes(i)) ?? null;
