-- Down for 0040_research_assessment_history: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP VIEW public.research_assessment_history;
CREATE OR REPLACE VIEW public.research_assessments_current AS  SELECT ra.id,
    ra.item_id,
    ra.supersedes,
    ra.is_current,
    ra.technical_maturity_low,
    ra.technical_maturity_high,
    ra.technical_maturity_method,
    ra.technical_maturity_evidence_ids,
    ra.commercial_maturity_low,
    ra.commercial_maturity_high,
    ra.commercial_maturity_method,
    ra.commercial_maturity_evidence_ids,
    ra.horizon_kind,
    ra.horizon_band,
    ra.horizon_rule,
    ra.horizon_confidence,
    ra.horizon_trigger_note,
    ra.refusal_reason,
    ra.credibility_evidence_score,
    ra.credibility_authority_score,
    ra.computed_by,
    ra.computed_at,
    ra.status_token,
    ra.created_at,
    ra.entity_id,
    ra.lifecycle_state
   FROM public.research_assessments ra
  WHERE ra.is_current;
ALTER VIEW public.research_assessments_current SET (security_invoker=on);
