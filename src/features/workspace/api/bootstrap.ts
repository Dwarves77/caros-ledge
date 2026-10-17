// Ported from old_repo/src/app/api/workspace/bootstrap/route.ts (lines 42-96)
// Ported from old_repo/src/app/api/workspace/bootstrap/logic.ts (lines 116-199)
import { currentMembership } from "@/core/auth/membership";
import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import type { Db } from "@/core/db/clients";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db/query";
import { LookupError, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { log } from "@/core/shared/log";
import { loadRoster, type RosterMember } from "@/core/workspace/roster";

import type { WorkspaceOverride } from "../state/types";

import { workspaceDeps } from "./deps";
import { loadPersonalState } from "./personal-state";

// GET /api/workspace/bootstrap: the per-user bundle the shell hydrates after first paint, in ONE round trip (personal state, members, admin
// attention, the org's overrides, nav counts, the assistant flag). Public intelligence stays server-cached; per-user state rides here.
// Each field resolves independently, and a field whose read FAILED is null and named in `degraded` (with its cause logged), so a member
// picker that is briefly unavailable never takes personal state down with it, and nothing renders a failed read as "none".
const OVERRIDE_CAP = 5000;
type OverrideDbRow = { item_id: string; priority_override: string | null; is_archived: boolean | null; archive_reason: string | null; archive_note: string | null; archived_at: string | null; dismissed_at: string | null; owner_user_id: string | null };

/** The caller's org-scoped override rows mapped to the UI shape (ids are the UI id: legacy id, else uuid; owner names come from the org roster, so a departed owner reads as unassigned). */
export async function loadOverrides(db: Db, orgId: string, roster: readonly RosterMember[]): Promise<WorkspaceOverride[]> {
  let rows: OverrideDbRow[];
  try {
    rows = await fetchAllRows(
      (from, to) => db.from("workspace_item_overrides").select("item_id, priority_override, is_archived, archive_reason, archive_note, archived_at, dismissed_at, owner_user_id").eq("org_id", orgId).order("item_id", { ascending: true }).range(from, to),
      { cap: OVERRIDE_CAP },
    );
  } catch (e) {
    throw new LookupError("workspace_item_overrides", e);
  }
  if (rows.length === 0) return [];
  const items = await fetchAllByIdChunks(rows.map((r) => r.item_id), async (slice) => {
    const { data, error } = await db.from("intelligence_items").select("id, legacy_id").in("id", slice);
    if (error) throw new LookupError("intelligence_items", error);
    return (data ?? []) as { id: string; legacy_id: string | null }[];
  });
  const uiId = new Map(items.map((r) => [r.id, r.legacy_id || r.id]));
  const names = new Map(roster.map((m) => [m.user_id, m.display_name]));
  return rows.map((o) => ({
    itemId: uiId.get(o.item_id) ?? o.item_id,
    priorityOverride: o.priority_override ?? null,
    isArchived: !!o.is_archived,
    archiveReason: o.archive_reason ?? null,
    archiveNote: o.archive_note ?? null,
    archivedAt: o.archived_at ?? null,
    dismissedAt: o.dismissed_at ?? null,
    ownerUserId: o.owner_user_id ?? null,
    ownerName: o.owner_user_id ? (names.get(o.owner_user_id) ?? null) : null,
  }));
}

export const GET = route("/api/workspace/bootstrap", async (request) => {
  const deps = workspaceDeps();
  const timePhase = deps.timePhase ?? (<T>(_phase: string, run: () => Promise<T>) => run());
  const user = await timePhase("auth", () => requireUser(request));
  if (isRefusal(user)) return user;
  const db = user.client;
  const degraded: string[] = [];
  // One org and one roster read feed both `members` and the owner names of `overrides`.
  const org = currentMembership(user.client, user.userId);
  const roster = org.then((m) => (m ? loadRoster(db, m.orgId) : null));
  const phase = <T>(name: string, run: () => Promise<T>): Promise<T | null> =>
    timePhase(name, run).catch((e: unknown) => {
      degraded.push(name);
      log.warn(`[workspace-bootstrap] ${name} unavailable:`, e instanceof Error ? e.message : String(e));
      return null;
    });

  const [personalState, members, adminAttention, overrides, navCounts] = await Promise.all([
    phase("personal_state", () => loadPersonalState(db, user.userId)),
    phase("members", async () => (await roster)?.map((m) => ({ user_id: m.user_id, role: m.role, display_name: m.display_name, avatar_url: m.avatar_url })) ?? null),
    phase("admin_attention", async () => {
      if (!(await readOwnPlatformAdmin(user.client))) return null;
      if (!deps.adminAttention) throw new Error("admin attention is not wired");
      return deps.adminAttention(user.userId);
    }),
    phase("overrides", async () => {
      const [membership, members] = await Promise.all([org, roster]);
      return membership && members ? loadOverrides(db, membership.orgId, members) : [];
    }),
    phase("nav_counts", async () => {
      if (!deps.navCounts) throw new Error("nav counts are not wired");
      const membership = await org;
      return membership ? deps.navCounts({ orgId: membership.orgId, userId: user.userId }) : null;
    }),
  ]);
  // The Assistant is free (no model, no spend), so it is on; the one switch is an exact "false", read fresh each request so turning it off needs no redeploy.
  const payload = { personalState, members, adminAttention, overrides, navCounts, assistantEnabled: process.env.ASSISTANT_ENABLED !== "false", degraded };
  const response = Response.json(payload, { headers: { ...user.headers, "Cache-Control": "private, no-store" } });
  return deps.withServerTiming ? deps.withServerTiming(response) : response;
});
