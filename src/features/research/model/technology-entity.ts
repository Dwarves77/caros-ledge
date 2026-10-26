// New in JOIN-1 (scripts/ci/new-files/join-1.txt): the entity a research assessment is filed under. An assessment rates a technology or a fuel; the coupling vocabulary (src/core/coupling/data/couplings.json) names those as carrier, node and feedstock entities and
// lists the operational scenario tags that each one covers. The entity is read from the item's TYPED tags through that list, never from the item's words (the flywheel matches no prose): the one technology the tags name, else none. An item whose tags name
// several technologies, or none, is filed under none and the coverage map (scripts/ci/joinability.mjs) reports it.
import { couplingsForScenario } from "@/core/coupling/coupling";

/** The classes an assessment can rate: a fuel or energy carrier, an infrastructure node, a feedstock. Modes, hubs, corridors, attributes and windows are lenses, not technologies. */
const TECHNOLOGY_CLASSES = new Set(["carrier", "node", "feedstock"]);

export function technologyEntityOf(tags: readonly string[] | null | undefined): string | null {
  const named = new Set((tags ?? []).flatMap((tag) => couplingsForScenario(tag).filter((c) => TECHNOLOGY_CLASSES.has(c.class)).map((c) => c.entityId)));
  return named.size === 1 ? ([...named][0] as string) : null;
}
