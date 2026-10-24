// New in CTX-5 (no old source). The forward view of a theme as STRUCTURE only (ADR-050: a reader authors sentences, code classifies and lists): which members sit in which horizon, on which surfaces,
// which are the theme's pivots, and the dated forward events that place them. Every string out is an id from the input, a horizon token from data/horizons.json, a surface key, or an event field.
// The horizon of a member comes from its own recorded band or, failing that, its earliest dated event or compliance deadline against `asOfIso`; a member with neither is `unplaced`, never guessed from its page.
import { SURFACE_ORDER, surfaceOf } from "@/core/routing";

import horizonsJson from "./data/horizons.json";
import { parseHorizons } from "./horizons";

/** Parsed at load: a data file missing a key, or naming a token outside its own lists, refuses at startup. */
export const HORIZONS = parseHorizons(horizonsJson);

export interface ForwardMember {
  id: string;
  item_type: string | null;
  domain: number | null;
  horizon?: string | null;
  horizon_band?: string | null;
  compliance_deadline?: string | null;
}
export interface ThemeEventRow {
  id: string;
  intelligence_item_id: string;
  event_date: string;
  date_precision: string;
  event_kind: string;
}
export interface ThemeHorizonOutlook {
  horizon: string;
  memberIds: string[];
  surfaces: string[];
  pivotIds: string[];
  triggers: Array<{ eventId: string; itemId: string; date: string; precision: string; kind: string }>;
}
export interface ThemeForwardOutlook {
  horizons: ThemeHorizonOutlook[];
}

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** A recorded horizon string as a horizon token: the token itself (en dash read as a hyphen) or a stored band; null when it is neither. */
function recordedToken(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/\u2013/g, "-");
  return HORIZONS.order.includes(s) ? s : (HORIZONS.bandToken[s.toUpperCase()] ?? null);
}

function horizonOf(m: ForwardMember, events: readonly ThemeEventRow[], asOfIso: string): string {
  const recorded = recordedToken(m.horizon ?? m.horizon_band);
  if (recorded) return recorded;
  const first = [...events.map((e) => e.event_date), m.compliance_deadline].filter((d): d is string => typeof d === "string" && DATE_RE.test(d)).sort()[0];
  const days = first ? Math.round((Date.parse(first) - Date.parse(asOfIso)) / DAY_MS) : NaN;
  if (!Number.isFinite(days)) return HORIZONS.unplaced;
  return HORIZONS.order.slice(0, -1).find((t) => days <= (HORIZONS.cutoffDays[t] as number)) ?? (HORIZONS.order[HORIZONS.order.length - 1] as string);
}

export function deriveThemeForwardOutlook(input: { memberIds: readonly string[]; pivotIds: readonly string[]; members: readonly ForwardMember[]; events: readonly ThemeEventRow[]; asOfIso: string }): ThemeForwardOutlook {
  const inTheme = new Set(input.memberIds);
  const buckets = new Map<string, ForwardMember[]>();
  for (const m of input.members) {
    if (!m || !inTheme.has(m.id)) continue;
    const h = horizonOf(m, input.events.filter((e) => e.intelligence_item_id === m.id), input.asOfIso);
    buckets.set(h, [...(buckets.get(h) ?? []), m]);
  }
  const pivots = new Set(input.pivotIds);
  const horizons = [...HORIZONS.order, HORIZONS.unplaced].flatMap((h): ThemeHorizonOutlook[] => {
    const members = buckets.get(h);
    if (!members?.length) return [];
    const ids = new Set(members.map((m) => m.id));
    const surfaces = new Set(members.map((m) => surfaceOf(m.item_type, m.domain)));
    return [
      {
        horizon: h,
        memberIds: members.map((m) => m.id),
        surfaces: SURFACE_ORDER.filter((s) => surfaces.has(s)),
        pivotIds: members.map((m) => m.id).filter((id) => pivots.has(id)),
        triggers: input.events
          .filter((e) => ids.has(e.intelligence_item_id))
          .sort((a, b) => (a.event_date < b.event_date ? -1 : a.event_date > b.event_date ? 1 : a.id < b.id ? -1 : 1))
          .map((e) => ({ eventId: e.id, itemId: e.intelligence_item_id, date: e.event_date, precision: e.date_precision, kind: e.event_kind })),
      },
    ];
  });
  return { horizons };
}
