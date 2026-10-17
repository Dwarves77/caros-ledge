// A parity waiver of kind 'until-migration' covers a difference that exists only because production carries no new migration before the cutover window (tests/parity/compare.mjs). It retires itself:
// supabase/migrations/APPLIED.json (written at the cutover; absent until then) lists the migrations production carries, and a waiver that names a listed migration fails the check.
export function appliedMigrations(json) {
  const list = Array.isArray(json) ? json : json?.applied;
  return new Set((Array.isArray(list) ? list : []).map(String));
}
export function retiredWaiverProblems(config, applied) {
  return (config.approved ?? [])
    .filter((a) => a.kind === 'until-migration' && applied.has(String(a.migration)))
    .map((a) => `tests/parity/approved-changes.json: waiver ${a.id} is until migration ${a.migration}, which APPLIED.json lists: delete the waiver (the difference is now a real one)`);
}
