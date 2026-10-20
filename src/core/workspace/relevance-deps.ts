// Ported from old_repo/src/app/api/detail/relevance/route.ts (lines 42-79)
// The lens's three tables and its gate, from their one homes (the applicability gate, the closed vocabularies, the sector list): the detail relevance route and the list readers (a row's client score) read the same deps.
import { computeApplicability } from "@/core/applicability";
import { DUTY_HOLDER_CLASSES, VOCABULARIES } from "@/core/contracts/vocabularies";

import type { RelevanceDeps } from "./relevance";
import { ALL_SECTORS } from "./vocabulary";

export const relevanceDeps: RelevanceDeps = {
  computeApplicability,
  dutyHolderClasses: Object.fromEntries(Object.values(DUTY_HOLDER_CLASSES).map((c) => [c.code, { label: c.label, orgRoles: c.orgRoles ?? [] }])),
  bindingPosition: Object.fromEntries(Object.values(VOCABULARIES.binding_position ?? {}).map((p) => [p.code, { code: p.code, label: p.label, note: String((p as { note?: unknown }).note ?? ""), order: p.order ?? 0 }])),
  sectors: ALL_SECTORS,
};
