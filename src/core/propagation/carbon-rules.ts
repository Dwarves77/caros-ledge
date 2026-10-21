// New in CARBON-1 (scripts/ci/new-files/carbon-1.txt): the rules of the carbon cost per FEU as validated data. Everything a method needs that is not code (the series it reads, the units it accepts, the rating that makes an input filing-grade, the
// physical constants of the great-circle and the unit conversion, the words of every absence) is data/carbon.json; the method-version gate hashes the file with the methods that read it, so editing it is editing the method. No price, distance,
// payload or intensity is in this file or in code: each is read from the store.
import { z } from "zod";

import carbonJson from "./data/carbon.json";

const observed = z.object({ seriesPrefix: z.string().min(1), units: z.array(z.string().min(1)).min(1), unit: z.string().min(1), currency: z.string().length(3).nullable() }).strict();
const text = z.string().min(1);

export const CARBON = z
  .object({
    filingMaxTier: z.number().int().min(1).max(7),
    observedConfidence: z.number().min(0).max(1),
    price: observed,
    payload: observed,
    distance: z.object({ earthRadiusKm: z.number().positive(), admissibility: z.enum(["display_only", "analysis_ok", "calculation_ok", "filing_ok"]), confidence: z.number().min(0).max(1), basis: text }).strict(),
    cost: z.object({ unit: text, gramsPerTonne: z.number().positive(), intensityUnit: text, basis: text }).strict(),
    labels: z.object({ price: text, distance: text, payload: text, intensity: text, cost: text }).strict(),
    absence: z.object({ price: text, payload: text, distance: text, intensity: text, intensityMany: text, cost: text, unwritten: text, pending: text }).strict(),
  })
  .strict()
  .parse(carbonJson);

/** A label inside a sentence: only its first letter is lowered ("Payload per FEU" reads "payload per FEU"). */
export const inSentence = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);
