// Writes src/features/statutory/data/filing-grade.json from the evidence rows and the exported capture texts: the ONLY way that file changes.
//   node --import ./tests/_support/register.mjs tests/statutory/regenerate.mjs
// A capture is exported by saving the stored capture's text (agent_run_searches.result_content for its id) as src/features/statutory/data/captures/<capture_id>.txt; the evidence row (filing-grade-inputs.json) names the
// capture id and the day it was verified. Nothing else in the repository states which years are filing grade.
import { writeFileSync } from "node:fs";

import { derivedFilingGrade, GENERATED_PATH, headerOf } from "./filing-grade-support.mjs";

const doc = derivedFilingGrade(new Date());
writeFileSync(GENERATED_PATH, `${JSON.stringify({ _generated: headerOf(), ...doc }, null, 1)}\n`);
const summary = Object.entries(doc.instruments).map(([id, g]) => `${id}: ${g.years.join(",") || "no year"}`).join("; ");
process.stdout.write(`wrote ${GENERATED_PATH}: ${summary}\n`);
