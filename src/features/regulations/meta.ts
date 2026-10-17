// Ported from old_repo/src/lib/detail/meta-line.ts (lines 1-48)
// Ported from old_repo/src/app/regulations/[slug]/page.tsx (lines 154-186)
// The detail page's dek, built ONCE as a segment array (the old page built a string, the surface split it and joined it again). A segment already said by an earlier one, whole or as one of its
// parts, is not said twice.
import { formatDate } from "@/core/shared";
import { jurisLabelOf } from "@/core/jurisdictions";
import type { Resource } from "@/core/types";

const key = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const atoms = (s: string): string[] => [key(s), ...s.split(/\s+[/·]\s+/).map(key)].filter(Boolean);

export function joinSegments(segments: ReadonlyArray<string | null | undefined | false>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of segments) {
    const s = raw ? String(raw).trim() : "";
    if (!s || seen.has(key(s))) continue;
    out.push(s);
    for (const a of atoms(s)) seen.add(a);
  }
  return out.join(" · ");
}

/** The jurisdiction in words, the publisher line and the one dek of a regulation page. */
export function regulationMeta(r: Resource): { jurisLabel: string; dek: string } {
  const jurisLabel = jurisLabelOf(r);
  const publisher = r.enforcementBody || r.sourceName || null;
  const modes = r.modes && r.modes.length > 0 ? r.modes.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(" · ") : null;
  return { jurisLabel, dek: joinSegments([publisher ? `${jurisLabel} · ${publisher}` : jurisLabel, r.legalInstrument || publisher, r.complianceDeadline ? `Effective ${formatDate(r.complianceDeadline)}` : null, r.lastVerifiedDate ? `Reviewed ${formatDate(r.lastVerifiedDate)}` : null, modes]) };
}
