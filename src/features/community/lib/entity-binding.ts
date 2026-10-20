// Ported from old_repo/src/lib/community/entity-binding.mjs (lines 1-35)
// Ported from old_repo/src/components/community/identity-format.ts (lines 43-58)
// Every thread binds to 1 to 10 well-formed spine entities (INV-223, INV-236). The client composer and the route run this one validator, so the two can never drift; the database repeats the count in create_thread.
import { entityKindOf } from "@/core/entities/kinds";

const MIN_ENTITY_IDS = 1;
export const MAX_ENTITY_IDS = 10;

export type EntityBinding = { ok: true; entityIds: string[] } | { ok: false; error: string };

export function validateEntityIds(raw: unknown): EntityBinding {
  const entityIds = [...new Set((Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()))];
  if (entityIds.length < MIN_ENTITY_IDS) return { ok: false, error: "Bind this post to at least one corridor, jurisdiction, instrument, technology or organisation before posting." };
  if (entityIds.length > MAX_ENTITY_IDS) return { ok: false, error: `A post can be bound to ${MAX_ENTITY_IDS} or fewer entities.` };
  const malformed = entityIds.filter((id) => !entityKindOf(id));
  if (malformed.length > 0) return { ok: false, error: "One of the chosen entities is not valid. Choose it again from the list." };
  return { ok: true, entityIds };
}

/** The composer's live message: a refusal string, or null when the binding is valid. */
export const entityBindingMessage = (ids: unknown): string | null => {
  const r = validateEntityIds(ids);
  return r.ok ? null : r.error;
};
