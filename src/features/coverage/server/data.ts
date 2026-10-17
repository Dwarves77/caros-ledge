// Ported from old_repo/src/lib/coverage/matrix-data.ts (lines 1-54)
import { countryLabel } from "@/core/jurisdictions";
import { serviceClient } from "@/core/db";

import { makeCoverageData } from "./matrix-data";

/** The cached coverage readers, bound to the service client (the matrix is aggregate counts of the catalogue, never a person's data), the clock and the jurisdiction labels. */
export const coverageData = makeCoverageData({ db: serviceClient, now: () => new Date().toISOString(), labelOf: countryLabel, tag: "app-data" });
