// Ported from old_repo/src/components/community/identity-format.ts (lines 1-58)
// The author identity line and its anonymous label: name and company first when shown, then org type, role, sector and region. An anonymous author leads with the anonymous label, so a withheld name reads as a
// choice and the verified mark always has a line to sit beside.
import { ORG_TYPE_LABELS, regionLabel } from "./labels";
import type { AuthorBlock } from "./types";

export const ANONYMOUS_LABEL = "Anonymous member";

export function formatAuthorIdentity(a: AuthorBlock | null | undefined): string | null {
  if (!a) return null;
  const parts = [a.name, a.company, a.orgType ? (ORG_TYPE_LABELS[a.orgType] ?? a.orgType) : null, a.role, a.sector, a.region ? regionLabel(a.region) : null].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** The label the identity line draws; null only when there is nothing at all to show. */
export function authorIdentityLabel(a: AuthorBlock | null | undefined): string | null {
  const line = formatAuthorIdentity(a);
  if (!a?.anonymous) return line;
  return line ? `${ANONYMOUS_LABEL} · ${line}` : ANONYMOUS_LABEL;
}
