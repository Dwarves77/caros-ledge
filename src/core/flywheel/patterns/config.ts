// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the thresholds of the five pattern detectors as validated data (data/patterns.json, carrying a version) and the per-table adapters that turn a stored row into the fact a detector reads (data/facts.json).
// The method-version gate hashes both files with the detectors that read them, so editing a threshold without registering a new method version turns the gate red. No quantity, rate, price or factor is typed in code: each is read from the store or from these files.
import { z } from "zod";

// the unit map of the parse module is read here too, so the method-version gate hashes it with the detectors whose facts it reads
import type { UnitForm } from "../../parse";
import statutoryUnitsJson from "../../parse/data/statutory-units.json";

import factsJson from "./data/facts.json";
import patternsJson from "./data/patterns.json";

const confidenceScale = z.number().min(0).max(1);
const dayCount = z.number().int().positive();
export const PATTERNS = z
  .object({
    version: z.string().min(1),
    analysisMaxTier: z.number().int().min(1).max(7),
    velocity: z.object({ windowsDays: z.array(dayCount).min(1), baselineDays: dayCount, minBaseline: dayCount, maxEvidence: dayCount, minSources: dayCount, minDistinct: dayCount, excludeKinds: z.array(z.string()), excludeClasses: z.array(z.string()), confidence: confidenceScale }).strict(),
    mandateCapacity: z.object({ confidence: confidenceScale }).strict(),
    leadLag: z.object({ triggerKinds: z.array(z.string()).min(1), leadDays: z.tuple([dayCount, dayCount]), moveWindowDays: dayCount, minMove: z.number().positive(), confidence: confidenceScale }).strict(),
    crossModal: z.object({ relations: z.record(z.string(), z.number().positive().max(1)), excludeClasses: z.array(z.string()), recencyDays: dayCount, minStrength: z.number().min(0).max(1), minMove: z.number().positive(), confidence: confidenceScale }).strict(),
    penaltyAbatement: z.object({ minTrl: z.number().int().min(1), band: z.number().positive(), confidence: confidenceScale }).strict(),
    /** The kinds whose prediction is tracked (a signpost each), the direction a standing pattern scores in and who scores it. */
    signposts: z.object({ kinds: z.array(z.enum(["velocity", "mandateCapacity", "leadLag", "crossModal", "penaltyAbatement"])), direction: z.enum(["confirms", "refutes", "delays"]), scoredBy: z.string().min(1) }).strict(),
    /** The discovery hook: the surface an entity class is read on and the venue class that publishes on each surface. */
    discovery: z.object({ surfaceOfClass: z.record(z.string(), z.string()), venueOfSurface: z.record(z.string(), z.string()) }).strict(),
  })
  .strict()
  .parse(patternsJson);

const columnName = z.string().min(1);
const quantitySpec = z.object({ column: columnName.optional(), unit: columnName.optional(), unitColumn: columnName.optional(), figure: columnName.optional() }).strict();
const factSpecSchema = z
  .object({ role: z.enum(["claim", "ratchet", "capacity", "series", "trigger", "tech", "move", "ceiling", "abatement"]), pk: columnName, edge: columnName.optional(), surface: columnName.optional(), at: columnName.optional(), due: columnName.optional(), dueYear: columnName.optional(), dueMonthsAfterAt: columnName.optional(), qty: quantitySpec.optional(), source: columnName.optional(), tier: columnName.optional(), kind: columnName.optional(), trl: columnName.optional(), group: columnName.optional(), item: columnName.optional(), owner: columnName.optional(), capture: columnName.optional(), resolved: columnName.optional(), from: columnName.optional(), until: columnName.optional() })
  .strict();
export const UNIT_FORMS: readonly UnitForm[] = statutoryUnitsJson.forms;
export type FactSpec = z.infer<typeof factSpecSchema>;
/** The specs per table, in file order: a table may be read as more than one role (an obligation is a ratchet by its mandated quantity and date, and a ceiling by its penalty maximum while that is in force). */
export const FACT_SPECS: Readonly<Record<string, readonly FactSpec[]>> = Object.fromEntries(Object.entries(z.record(z.string(), z.union([factSpecSchema, z.array(factSpecSchema).min(1)])).parse(factsJson)).map(([t, s]) => [t, [s].flat()]));
