// The derivation of data/filing-grade.json from its evidence, for the drift guard (filing-grade.test.ts) and the regenerator (regenerate.mjs): one function, so the file and its check cannot disagree.
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { deriveFilingGrade, filingInstruments } from "@/features/statutory/filing-grade";

export const GENERATED_PATH = "src/features/statutory/data/filing-grade.json";
export const CAPTURES_DIR = "src/features/statutory/data/captures";
export const headerOf = () =>
  "Derived by deriveFilingGrade from filing-grade-inputs.json and data/captures/*.txt (tests/statutory/regenerate.mjs writes it). Never edited by hand: the drift guard in tests/statutory/filing-grade.test.ts fails when this file differs from the derivation.";

/** capture id to text, from the exported captures (data/captures/<capture_id>.txt). */
export const exportedCaptures = () =>
  new Map(existsSync(CAPTURES_DIR) ? readdirSync(CAPTURES_DIR).filter((f) => f.endsWith(".txt")).map((f) => [f.replace(/\.txt$/, ""), readFileSync(`${CAPTURES_DIR}/${f}`, "utf8")]) : []);

export const derivedFilingGrade = (now) => deriveFilingGrade(filingInstruments(), exportedCaptures(), now);
export const committedFilingGrade = () => JSON.parse(readFileSync(GENERATED_PATH, "utf8"));
