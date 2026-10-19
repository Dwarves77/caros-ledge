// Ported from old_repo/src/components/community/ProfileForm.tsx (lines 27-48)
// Ported from old_repo/src/components/community/ReportPostMenu.tsx (lines 21-28)
// Ported from old_repo/src/components/community/ModerationQueue.tsx (lines 74-81)
// Ported from old_repo/src/lib/community/identity.mjs (lines 1-11)
// Ported from old_repo/src/lib/community/antitrust.mjs (lines 13-23)
// The Community vocabularies, as data validated at load: organisation types, the commercially sensitive fields, the report reasons and the moderation actions. Regions come from the core workspace vocabulary.
import { z } from "zod";

import { REGIONS } from "@/core/workspace/vocabulary";

import vocabulary from "./data/vocabulary.json";

const id = z.string().min(1);
const schema = z.object({
  orgTypes: z.array(z.object({ id, label: id })).min(1),
  sensitiveFields: z.array(z.object({ id, label: id })).min(1),
  reportReasons: z.array(z.object({ id, label: id, short: id })).min(1),
  moderationActions: z.array(id).min(1),
});
const V = schema.parse(vocabulary);

export const ORG_TYPES: readonly string[] = V.orgTypes.map((o) => o.id);
export const ORG_TYPE_OPTIONS = V.orgTypes;
export const ORG_TYPE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(V.orgTypes.map((o) => [o.id, o.label]));
/** The kinds of figure the antitrust guard names, by id (the rules in data/antitrust-rules.json each name one). */
export const SENSITIVE_FIELD_LABELS: Readonly<Record<string, string>> = Object.fromEntries(V.sensitiveFields.map((f) => [f.id, f.label]));
export const REPORT_REASONS = V.reportReasons;
export const REPORT_REASON_IDS: readonly string[] = V.reportReasons.map((r) => r.id);
export const REPORT_REASON_SHORT: Readonly<Record<string, string>> = Object.fromEntries(V.reportReasons.map((r) => [r.id, r.short]));
export const MODERATION_ACTIONS = V.moderationActions as readonly ModerationAction[];
export type ModerationAction = "dismiss" | "warn" | "remove" | "mute" | "ban";

/** The community region codes (profiles, groups, member regions): the core vocabulary's, one list. */
export const REGION_CODES: readonly string[] = REGIONS.map((r) => r.id);
export const REGION_LABELS: Readonly<Record<string, string>> = Object.fromEntries(REGIONS.map((r) => [r.id, r.label]));
export const regionLabel = (code: string | null | undefined): string => (code ? (REGION_LABELS[code] ?? code) : "");

/** The length limits the routes enforce and the forms show, one pair per field (create and rename used 120/80 and 1000/600; the database rpc holds the create pair). */
export const LIMITS = { groupName: 120, groupDescription: 1000, postTitle: 200, postBody: 8000, replyBody: 4000, reportBody: 2000, moderationNote: 1000, decisionNote: 2000, search: 200 } as const;

/** What each spine entity kind is called to a member. */
export const ENTITY_KIND_LABEL: Readonly<Record<string, string>> = { corridor: "Corridor", node: "Node", jurisdiction: "Jurisdiction", organisation: "Organisation", asset: "Asset", instrument: "Instrument", obligation: "Obligation", method: "Method", technology: "Technology", signpost: "Signpost", person: "Person", material: "Material" };

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Active in the last seven days, measured from the request's instant (the old card and header each read the clock in render and carried a comment to keep their copies in step). */
export const isRecentlyActive = (lastActiveAt: string | null | undefined, nowIso: string): boolean => {
  const t = lastActiveAt ? Date.parse(lastActiveAt) : NaN;
  return !Number.isNaN(t) && Date.parse(nowIso) - t < WEEK_MS;
};
