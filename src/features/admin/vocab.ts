// Ported from old_repo/src/app/api/admin/integrity-flags/route.ts (lines 146-359)
// Ported from old_repo/src/app/api/admin/triage/ingest-rejections/route.ts (lines 8-112)
// Ported from old_repo/src/app/api/admin/triage/pending-jurisdiction-review/route.ts (lines 9-197)
// The admin vocabularies a screen and its route both need, with no import: a client component takes them from here, never from a server module.

/** The seven categories the integrity_flags CHECK admits (INV-290); a test compares this list with the CHECK in supabase/schema.sql. */
export const PLATFORM_CATEGORIES = ["design_drift", "data_quality", "source_issue", "coverage_gap", "data_integrity", "surface_concern", "workflow_gap"] as const;
export const PLATFORM_STATUSES = ["open", "in_review", "resolved", "archived"] as const;
export const REJECTION_ACTIONS = ["discarded", "reclassified", "escalated"] as const;
export const JURISDICTION_ACTIONS = ["confirm", "manually-classify", "dismiss"] as const;
