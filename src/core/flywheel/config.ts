// Ported from old_repo/src/lib/connections/discover.mjs (lines 62-73)
// Ported from old_repo/src/lib/connections/intersections.mjs (lines 5-7)
// Ported from old_repo/src/lib/connections/pair-view.mjs (line 1)
// Ported from old_repo/src/lib/connections/theme-stats.mjs (line 36)
// Ported from old_repo/src/lib/connections/cluster.mjs (lines 3-4)
// Ported from old_repo/src/lib/connections/theme-delta.mjs (line 1)
// Every tuning number of the connection layer, as data (data/discovery.json), validated at load.
import { z } from "zod";

import raw from "./data/discovery.json";

const num = z.number().finite();
const schema = z.object({
  weights: z.object({ shared_source: num, shared_scenario: num, shared_compliance_object: num, shared_jurisdiction_topic: num, shared_entity: num, shared_obligation: num }),
  perTagCap: z.number().int().positive(),
  threshold: num,
  limit: z.number().int().positive(),
  roleTags: z.array(z.string()),
  intersection: z.object({ points: z.object({ scenario: num, object: num, explicit: num, priority: num }), tierMin: z.object({ strong: num, medium: num }), highPriority: z.array(z.string()) }),
  pairBands: z.object({ strong: num, medium: num }),
  convergenceBands: z.object({ high: num, medium: num }),
  cluster: z.object({ maxRounds: z.number().int().positive(), pivotK: z.number().int().positive() }),
  themeOverlapThreshold: num,
});
export const CONFIG = schema.parse(raw);
export const ROLE_TAGS: ReadonlySet<string> = new Set(CONFIG.roleTags);
export const CONVERGENCE_BANDS = CONFIG.convergenceBands;
