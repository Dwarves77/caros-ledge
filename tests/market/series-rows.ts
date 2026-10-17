// The six ratified series-to-item attachments exactly as the migrations seed them: 0030 inserts the (series_key, item_id) pairs and 0045 sets the weekly cadence. The producers read the TABLE, so a test seeds the table
// from these rows; the rows are parsed out of the migration files, never typed twice (so the table seed and what the producers see cannot drift).
import { readFileSync } from "node:fs";

import type { Row } from "../_support/memdb.ts";

const sql = (name: string): string => readFileSync(`supabase/migrations/${name}`, "utf8");

export const WEEKLY = [...new Set([...sql("0045_data_market_series_cadence.sql").matchAll(/'(eu-oil-bulletin:[a-z0-9-]+)'/g)].map((m) => m[1] as string))];
export const SEEDED_SERIES: Row[] = [...sql("0030_data_market_series_items.sql").matchAll(/^\('([^']+)', '([0-9a-f-]{36})'\)[,;]$/gm)].map((m) => ({ series_key: m[1], item_id: m[2], status: "ratified", cadence_days: WEEKLY.includes(m[1] as string) ? 7 : null, context_line: null, severity_tone: null }));
