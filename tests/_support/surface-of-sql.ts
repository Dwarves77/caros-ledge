// The CASE expression of public.surface_of(p_item_type text, p_domain integer), rendered from the routing rules (src/core/routing/data/surface-rules.json): the drift guard in tests/connect/edges.test.ts compares it with supabase/schema.sql.
import rules from "@/core/routing/data/surface-rules.json";

type Rule = { itemTypeIn?: string[]; domainIn?: number[]; surface: string };

export function renderSurfaceOfSql(): string {
  const lines = (rules.rules as Rule[]).map((r) => {
    const cond = r.itemTypeIn ? `p_item_type IN (${r.itemTypeIn.map((x) => `'${x}'`).join(", ")})` : `p_domain IN (${(r.domainIn ?? []).join(", ")})`;
    return `      WHEN ${cond} THEN '${r.surface}'`;
  });
  return ["    CASE", ...lines, `      ELSE '${rules.fallback}'`, "    END"].join("\n");
}
