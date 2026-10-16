// Ported from old_repo/src/lib/workspace/item-assignments.mjs (lines 25-223)
// Ported from old_repo/src/app/api/workspace/items/[id]/assignments/route.ts (lines 19-41)
import type { Db } from "@/core/db/clients";
import { boundedRead } from "@/core/db/query";
import { LookupError, route } from "@/core/http/errors";
import { isUuid } from "@/core/http/parse";
import { isIsoDate } from "@/core/shared/dates";
import { canWrite, collabFail, collabOk, isOrgAdmin, loadRoster, MAX_ASSIGNEES_PER_REQUEST, nameIndex, namesAfterWrite, readJsonObject, runCollab, type CollabCtx, type CollabResult } from "@/core/workspace/roster";

import { workspaceDeps } from "./deps";

// /api/workspace/items/[id]/assignments: multi-person assignment of one item (migration 359).
//   GET list + the picker | POST { assignees: [uuid], dueOn? } | PATCH { assignee, state } | DELETE ?assignee=
// Every assignee must hold a membership in the CALLER'S org and be able to write there (INV-167): one outsider or one viewer refuses
// the whole request with nothing written, and an unverifiable roster fails closed. assigned_by is the session user (INV-166).
const ASSIGNMENT_COLUMNS = "id, assignee_user_id, assigned_by, due_on, state, created_at";
const LIST_LIMIT = 200;
export const ASSIGNMENT_STATES = ["open", "done"] as const;
type Row = { id: string; assignee_user_id: string; assigned_by: string | null; due_on: string | null; state: string; created_at: string };

/** The assignee, the person who assigned it, or an owner or admin may change an assignment; always a writer. */
const mayChange = (row: Row, ctx: CollabCtx) => canWrite(ctx.role) && (row.assignee_user_id === ctx.userId || row.assigned_by === ctx.userId || isOrgAdmin(ctx.role));

function view(row: Row, ctx: CollabCtx, names: Map<string, string>) {
  return {
    id: row.id,
    assignee_user_id: row.assignee_user_id,
    assignee_name: names.get(row.assignee_user_id) ?? null,
    assigned_by: row.assigned_by,
    assigned_by_name: row.assigned_by == null ? null : (names.get(row.assigned_by) ?? null),
    due_on: row.due_on,
    state: row.state,
    created_at: row.created_at,
    can_change: mayChange(row, ctx),
  };
}

const viewer = (ctx: CollabCtx) => ({ role: ctx.role, can_write: canWrite(ctx.role) });

export async function listAssignments(client: Db, ctx: CollabCtx): Promise<CollabResult> {
  const [rows, roster] = await Promise.all([
    boundedRead<Row>((limit) => client.from("item_assignments").select(ASSIGNMENT_COLUMNS).eq("org_id", ctx.orgId).eq("item_id", ctx.item.id).order("created_at", { ascending: true }).limit(limit), { limit: LIST_LIMIT }),
    loadRoster(client, ctx.orgId),
  ]);
  if (rows.error) throw new LookupError("item_assignments", rows.error);
  const names = nameIndex(roster);
  return collabOk(200, {
    assignments: rows.data.map((row) => view(row, ctx, names)),
    truncated: rows.truncated,
    // The picker lists only members who can be assigned: a viewer is readable-only.
    members: roster.filter((m) => canWrite(m.role)).map((m) => ({ user_id: m.user_id, display_name: m.display_name })),
    viewer: viewer(ctx),
  });
}

/** Validate the POST body: { assignees, dueOn } or { error }. */
export function parseAssignInput(input: Record<string, unknown> | null): { assignees: string[]; dueOn: string | null } | { error: string } {
  const list = Array.isArray(input?.assignees) ? (input.assignees as unknown[]) : null;
  if (!list || list.length === 0) return { error: "Choose at least one person to assign." };
  if (list.length > MAX_ASSIGNEES_PER_REQUEST) return { error: `Assign at most ${MAX_ASSIGNEES_PER_REQUEST} people at a time.` };
  const assignees: string[] = [];
  for (const a of list) {
    if (typeof a !== "string" || !isUuid(a)) return { error: "Each assignee must be a workspace member id." };
    if (!assignees.includes(a)) assignees.push(a);
  }
  let dueOn: string | null = null;
  const due = input?.dueOn;
  if (due !== undefined && due !== null && due !== "") {
    if (!isIsoDate(due)) return { error: "Enter the due date as a real date (YYYY-MM-DD) or leave it empty." };
    dueOn = due;
  }
  return { assignees, dueOn };
}

export async function assignMembers(client: Db, ctx: CollabCtx, input: Record<string, unknown> | null): Promise<CollabResult> {
  if (!canWrite(ctx.role)) return collabFail(403, "Your role in this workspace can see assignments but not make them.");
  const parsed = parseAssignInput(input);
  if ("error" in parsed) return collabFail(400, parsed.error);
  const { assignees, dueOn } = parsed;

  const roster = await loadRoster(client, ctx.orgId);
  const names = nameIndex(roster);
  // Org guard: every assignee must hold a membership in the CALLER'S org. One outsider refuses the whole request and nothing is written.
  if (assignees.some((id) => !names.has(id))) return collabFail(403, "Everyone you assign must be a member of your workspace. Pick from the list and try again.");
  const roles = new Map(roster.map((m) => [m.user_id, m.role]));
  if (assignees.some((id) => !canWrite(roles.get(id)))) return collabFail(403, "A viewer can read this workspace but cannot be assigned work. Pick a member, admin or owner and try again.");

  const { data: existing, error: existingError } = await client.from("item_assignments").select("assignee_user_id").eq("org_id", ctx.orgId).eq("item_id", ctx.item.id).in("assignee_user_id", assignees);
  if (existingError) throw new LookupError("item_assignments", existingError);
  const already = new Set((existing ?? []).map((r) => (r as { assignee_user_id: string }).assignee_user_id));
  const fresh = assignees.filter((id) => !already.has(id));

  let created: Row[] = [];
  if (fresh.length > 0) {
    const { data, error } = await client
      .from("item_assignments")
      .insert(fresh.map((assignee) => ({ org_id: ctx.orgId, item_id: ctx.item.id, assignee_user_id: assignee, assigned_by: ctx.userId, due_on: dueOn })))
      .select(ASSIGNMENT_COLUMNS);
    if (error) return collabFail(500, error.message);
    created = (data ?? []) as Row[];
  }

  // Notification is best effort and counted, never silent: a dispatcher that is not wired counts every recipient as failed.
  const { notify, itemHref } = workspaceDeps();
  const assigner = names.get(ctx.userId) ?? "A teammate";
  const itemId = ctx.item.legacyId || ctx.item.id;
  const href = itemHref?.({ id: itemId, type: ctx.item.type, domain: ctx.item.domain }) ?? `/regulations/${encodeURIComponent(itemId)}`;
  let notified = 0;
  let notifyFailed = 0;
  for (const row of created) {
    if (row.assignee_user_id === ctx.userId) continue;
    const err = notify
      ? await notify({
          userId: row.assignee_user_id,
          kind: "assignment",
          payload: { title: "Assigned to you", body: `${assigner} assigned you "${ctx.item.title || "an item"}"${dueOn ? `, due ${dueOn}` : ""}.`, link: href, item_id: ctx.item.id, assigned_by: ctx.userId, due_on: dueOn },
        })
      : "notification dispatch is not wired";
    if (err) notifyFailed += 1;
    else notified += 1;
  }
  return collabOk(201, { assignments: created.map((row) => view(row, ctx, names)), already_assigned: assignees.filter((id) => already.has(id)), notified, notify_failed: notifyFailed });
}

async function findAssignment(client: Db, ctx: CollabCtx, assignee: string): Promise<Row | null> {
  const { data, error } = await client.from("item_assignments").select(ASSIGNMENT_COLUMNS).eq("org_id", ctx.orgId).eq("item_id", ctx.item.id).eq("assignee_user_id", assignee).maybeSingle();
  if (error) throw new LookupError("item_assignments", error);
  return (data as Row | null) ?? null;
}

const GONE = "That assignment no longer exists. Reload to see the current assignments.";

export async function setAssignmentState(client: Db, ctx: CollabCtx, input: Record<string, unknown> | null): Promise<CollabResult> {
  const assignee = typeof input?.assignee === "string" ? input.assignee : "";
  if (!isUuid(assignee)) return collabFail(400, "assignee is required.");
  const state = input?.state;
  if (state !== "open" && state !== "done") return collabFail(400, "state must be open or done.");
  const found = await findAssignment(client, ctx, assignee);
  if (!found) return collabFail(404, GONE);
  if (!mayChange(found, ctx)) return collabFail(403, "Only the assignee, the person who assigned it, or a workspace owner or admin can change this assignment.");
  const { data, error } = await client.from("item_assignments").update({ state }).eq("id", found.id).eq("org_id", ctx.orgId).select(ASSIGNMENT_COLUMNS).single();
  if (error) return collabFail(500, error.message);
  const names = await namesAfterWrite(client, ctx.orgId);
  return collabOk(200, { assignment: view(data as Row, ctx, names) });
}

export async function removeAssignment(client: Db, ctx: CollabCtx, input: { assignee?: string | null }): Promise<CollabResult> {
  const assignee = typeof input.assignee === "string" ? input.assignee : "";
  if (!isUuid(assignee)) return collabFail(400, "assignee is required.");
  const found = await findAssignment(client, ctx, assignee);
  if (!found) return collabFail(404, GONE);
  if (!mayChange(found, ctx)) return collabFail(403, "Only the assignee, the person who assigned it, or a workspace owner or admin can remove this assignment.");
  const { error } = await client.from("item_assignments").delete().eq("id", found.id).eq("org_id", ctx.orgId);
  if (error) return collabFail(500, error.message);
  return collabOk(200, { success: true });
}

type Ctx = { params: Promise<{ id: string }> };
const NAME = "/api/workspace/items/[id]/assignments";

export const GET = route<Ctx>(NAME, (request, context) => runCollab(request, context, (client, ctx) => listAssignments(client, ctx)));
export const POST = route<Ctx>(NAME, (request, context) => runCollab(request, context, async (client, ctx) => assignMembers(client, ctx, await readJsonObject(request))));
export const PATCH = route<Ctx>(NAME, (request, context) => runCollab(request, context, async (client, ctx) => setAssignmentState(client, ctx, await readJsonObject(request))));
export const DELETE = route<Ctx>(NAME, (request, context) => runCollab(request, context, (client, ctx) => removeAssignment(client, ctx, { assignee: new URL(request.url).searchParams.get("assignee") })));
