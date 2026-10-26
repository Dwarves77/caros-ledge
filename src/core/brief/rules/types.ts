// The brief validator's rule vocabulary (VALID-1). A rule is a pure function of a parsed brief and the item's columns: it reads no database, no clock and no environment.
/** One claim of the brief's ledger. `capture` is the text its span must be verbatim in (the item pool for a batch entry, the attributed capture for a stored row). */
export interface BriefClaim { kind: string; section: string; span: string | null; text: string; capture: string | null }
/** The parsed brief. `sections` is keyed by section number; `exempt` is further verbatim text a source adapter found (old-tree rows quote with ASCII marks). */
export interface BriefModel { body: string; format: string; sections: ReadonlyMap<string, string>; claims: readonly BriefClaim[]; exempt: readonly string[];
  /** FWD-COVER-1: the event_date of each entry in the entry's events block, and the dates it states it omits (omitted_events) with the reason. */
  events?: readonly string[]; omitted?: readonly { date: string; reason: string }[] }
/** The item row's columns a rule reads. `severity` is in ADR-052 token form (normalise a display label through severityToken before building this). */
export interface ItemColumns {
  severity: string | null; priority: string | null; urgency_tier: string | null; entry_into_force: string | null; compliance_deadline: string | null;
  what_it_changes: string | null; what_is_it: string | null; why_matters: string | null; topic_tags: readonly string[]; sources_used: readonly string[];
  signal_band: string | null; theme: string | null; format_type: string;
  /** Characters of the item's source pool and whether the metadata carries a requirement trajectory: the depth-accounting rule reads both. */
  pool_chars: number | null; has_trajectory: boolean;
  /** FWD-COVER-1: the ISO dates of the forward events and timeline rows the export supplied for the item. */
  supplied_dates?: readonly string[];
}
export interface Violation { rule: string; detail: string; excerpt: string }
export type Rule = (brief: BriefModel, item: ItemColumns) => Violation | null;
