// Ported from old_repo/src/lib/surface-of.mjs (lines 1-77)
// Ported from old_repo/src/lib/domains.ts (lines 1-24)
// Ported from old_repo/src/lib/connections/connection-view-model.mjs (lines 26-31)
// Ported from old_repo/src/lib/connections/connection-view-model.mjs (lines 152-160)
// The one item-to-surface routing rule. The rule list, the path, label and order tables are DATA (data/surface-rules.json); the SQL
// function public.surface_of is generated from the same rules (renderSurfaceOfSql) and a drift test compares it with schema.sql.
import { z } from "zod";

import rulesJson from "./data/surface-rules.json";

const rule = z.union([
  z.object({ itemTypeIn: z.array(z.string()).min(1), surface: z.string() }),
  z.object({ domainIn: z.array(z.number().int()).min(1), surface: z.string() }),
]);
const table = z.object({
  surfaces: z.array(z.string()).min(1),
  fallback: z.string(),
  rules: z.array(rule),
  path: z.record(z.string(), z.string()),
  label: z.record(z.string(), z.string()),
  order: z.array(z.string()),
});
const T = table.parse(rulesJson);

export type Surface = string;
const SURFACE_RULES = T.rules;
const FALLBACK_SURFACE = T.fallback;
export const SURFACE_PATH: Readonly<Record<string, string>> = T.path;
export const SURFACE_LABELS: Readonly<Record<string, string>> = T.label;
export const SURFACE_ORDER: readonly string[] = T.order;

/** The surface an item belongs on. Always (item_type, domain): the first matching rule wins, in rule order. */
export function surfaceOf(itemType: string | null | undefined, domain?: number | null): string {
  const t = itemType ?? null;
  const d = typeof domain === "number" ? domain : null;
  for (const r of SURFACE_RULES) {
    if ("itemTypeIn" in r && t !== null && r.itemTypeIn.includes(t)) return r.surface;
    if ("domainIn" in r && d !== null && r.domainIn.includes(d)) return r.surface;
  }
  return FALLBACK_SURFACE;
}

/** `/regulations/<id>` for a routed surface, null for an uncategorized item (no page to link to). */
export function surfaceHref(surface: string, id: string): string | null {
  const base = SURFACE_PATH[surface];
  return base ? `${base}/${encodeURIComponent(id)}` : null;
}
