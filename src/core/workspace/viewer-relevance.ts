// Ported from old_repo/src/lib/workspace/viewer-relevance.ts (lines 1-33)


/** The subset of intelligence_items columns the lens reads. */
export interface RelevanceInput {
  title?: string | null;
  transport_modes?: string[] | null;
  jurisdictions?: string[] | null;
  jurisdiction_iso?: string[] | null;
  topic_tags?: string[] | null;
  operational_scenario_tags?: string[] | null;
  compliance_object_tags?: string[] | null;
}

