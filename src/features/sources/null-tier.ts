

/** The aggregate merge and summary live with grounding (the null-tier flag); they are injected so this slice imports no unmerged module. */
export interface NullTierAggregateDeps {
  mergeNullTierAggregate: (prior: unknown, itemId: string, add: { factCount: number; samples: string[] }) => { sampleSpans?: unknown };
  summarizeNullTierAggregate: (host: string, aggregate: unknown, permanentClass: "aggregator" | "platform" | null) => { description: string; action: string; rationale: string };
}

