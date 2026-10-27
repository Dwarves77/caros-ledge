// The entity a research assessment is filed under. It was read from the item's typed scenario tags through the scenario lists of couplings.json; those lists were a hardcoded word-to-entity table and are gone (ADR-053, NO-ENTITY-LISTS-1, operator 2026-10-26: the database is the ontology).
// No table of the database maps a scenario tag to an entity yet, so an assessment is filed under no technology entity here and the coverage map (scripts/ci/joinability.mjs) reports it; the filing returns when the entity_relations the Reader asserts (an item's instrument implements a technology) carry it.
export function technologyEntityOf(tags: readonly string[] | null | undefined): string | null {
  void tags;
  return null;
}
