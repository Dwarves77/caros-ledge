// Ported from old_repo/src/lib/sources/null-tier-host-worklist.mjs (lines 20-68)
export const NULL_TIER_CREATED_BY = "null-tier-host";
export const NULL_TIER_RESOLVED_BY = "resolve-provisional-sources";

/** The aggregate merge and summary live with grounding (the null-tier flag); they are injected so this slice imports no unmerged module. */
export interface NullTierAggregateDeps {
  mergeNullTierAggregate: (prior: unknown, itemId: string, add: { factCount: number; samples: string[] }) => { sampleSpans?: unknown };
  summarizeNullTierAggregate: (host: string, aggregate: unknown, permanentClass: "aggregator" | "platform" | null) => { description: string; action: string; rationale: string };
}

/**
 * The null-tier host flag write for one (host, item, url) contribution: a pure merge over the EXISTING open flag, an insert for a fresh host or an update of
 * the same open flag (a repeat contribution from one item does not double-count). The caller performs the write and checks its result.
 */
export function buildNullTierHostWrite(deps: NullTierAggregateDeps, existing: { id?: string; recommended_actions?: Array<{ aggregate?: unknown }> } | null, host: string, itemId: string, url: string, permanentClass: "aggregator" | "platform" | null) {
  const aggregate = deps.mergeNullTierAggregate(existing?.recommended_actions?.[0]?.aggregate ?? null, itemId, { factCount: 1, samples: [url] });
  const { description, action, rationale } = deps.summarizeNullTierAggregate(host, aggregate, permanentClass);
  const row = {
    category: "source_issue" as const,
    subject_type: "source" as const,
    subject_ref: host,
    description: description.slice(0, 480),
    recommended_actions: [{ action, rationale, aggregate, sample_spans: aggregate.sampleSpans }],
    status: "open" as const,
    created_by: NULL_TIER_CREATED_BY,
  };
  return existing?.id ? ({ op: "update", id: existing.id, patch: row } as const) : ({ op: "insert", row } as const);
}

/** The resolve patch for an open null-tier flag whose host a rule or a committed verdict now places: the flag asked "which class?" and the answer closed it. */
export function buildNullTierHostResolution(host: string, placement: { rule?: "a" | "b" | "b2"; batch?: string | null; class?: string; tier: number }, nowIso: string) {
  const byRule = placement.rule === "a" || placement.rule === "b";
  return {
    status: "resolved" as const,
    resolved_at: nowIso,
    resolved_by: NULL_TIER_RESOLVED_BY,
    resolution_note: byRule
      ? `rule ${placement.rule} (${placement.rule === "a" ? "existing active institution" : "class table"}) now places ${host} at tier ${placement.tier}; no operator action needed.`
      : `host verdict batch ${placement.batch ?? "unknown"} places ${host} in class ${placement.class} (tier ${placement.tier}); registered by the class table, no operator action needed.`,
  };
}
