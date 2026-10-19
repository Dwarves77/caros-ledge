// Ported from old_repo/src/lib/workspace/item-notes.mjs (lines 1-132)
// Ported from old_repo/src/app/api/workspace/items/[id]/notes/route.ts (lines 15-37)
import { collabDbFail } from "./collab-db-fail";
import type { Db } from "@/core/db/clients";
import { boundedRead } from "@/core/db/query";
import { LookupError, route } from "@/core/http/errors";
import { canWrite, collabFail, collabOk, isOrgAdmin, loadRoster, nameIndex, namesAfterWrite, NOTE_MAX_LENGTH, readJsonObject, runCollab, type CollabCtx, type CollabResult } from "@/core/workspace/roster";

// /api/workspace/items/[id]/notes: private-per-workspace notes on one item (migration 358).
//   GET list (newest first) | POST { body } | PATCH { noteId, body } (author only) | DELETE ?noteId= (soft delete: author, owner or admin)
// A note is workspace commentary: it feeds no page but this item's own detail page, never the flywheel. Org, role and item are
// resolved server-side; the author is the session user, never the body (INV-166).
const NOTE_COLUMNS = "id, author_user_id, body, created_at, edited_at";
const LIST_LIMIT = 200;
type NoteRow = { id: string; author_user_id: string | null; body: string; created_at: string; edited_at: string | null };

const isMine = (row: NoteRow, ctx: CollabCtx) => row.author_user_id != null && row.author_user_id === ctx.userId;
/** The author deletes their own note (the same right as editing it); an owner or admin deletes any. */
const mayDelete = (row: NoteRow, ctx: CollabCtx) => isOrgAdmin(ctx.role) || (isMine(row, ctx) && canWrite(ctx.role));

function view(row: NoteRow, ctx: CollabCtx, names: Map<string, string>) {
  const mine = isMine(row, ctx);
  return {
    id: row.id,
    author_user_id: row.author_user_id,
    author_name: row.author_user_id == null ? null : (names.get(row.author_user_id) ?? null),
    body: row.body,
    created_at: row.created_at,
    edited_at: row.edited_at,
    mine,
    can_edit: mine && canWrite(ctx.role),
    can_delete: mayDelete(row, ctx),
  };
}

const viewer = (ctx: CollabCtx) => ({ role: ctx.role, can_write: canWrite(ctx.role) });

/** Validate a note body: { body } or { error }. Any string is accepted and trimmed. */
export function parseNoteBody(raw: unknown): { body: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Write a note before saving." };
  const body = raw.trim();
  if (!body) return { error: "Write a note before saving." };
  if (body.length > NOTE_MAX_LENGTH) return { error: `Notes are limited to ${NOTE_MAX_LENGTH} characters; this one is ${body.length}. Shorten it and save again.` };
  return { body };
}

export async function listNotes(client: Db, ctx: CollabCtx): Promise<CollabResult> {
  const [notes, roster] = await Promise.all([
    boundedRead<NoteRow>((limit) => client.from("item_notes").select(NOTE_COLUMNS).eq("org_id", ctx.orgId).eq("item_id", ctx.item.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(limit), { limit: LIST_LIMIT }),
    loadRoster(client, ctx.orgId),
  ]);
  if (notes.error) throw new LookupError("item_notes", notes.error);
  const names = nameIndex(roster);
  return collabOk(200, { notes: notes.data.map((row) => view(row, ctx, names)), truncated: notes.truncated, viewer: viewer(ctx) });
}

export async function addNote(client: Db, ctx: CollabCtx, input: Record<string, unknown> | null): Promise<CollabResult> {
  if (!canWrite(ctx.role)) return collabFail(403, "Your role in this workspace can read notes but not add them.");
  const parsed = parseNoteBody(input?.body);
  if ("error" in parsed) return collabFail(400, parsed.error);
  const { data, error } = await client.from("item_notes").insert({ org_id: ctx.orgId, item_id: ctx.item.id, author_user_id: ctx.userId, body: parsed.body }).select(NOTE_COLUMNS).single();
  if (error) return collabDbFail(error);
  return collabOk(201, { note: view(data as NoteRow, ctx, await namesAfterWrite(client, ctx.orgId)) });
}

/** One live note of THIS org and item, or null. Org and item scoping is the cross-org boundary. */
async function findNote(client: Db, ctx: CollabCtx, noteId: string): Promise<NoteRow | null> {
  const { data, error } = await client.from("item_notes").select(NOTE_COLUMNS).eq("id", noteId).eq("org_id", ctx.orgId).eq("item_id", ctx.item.id).is("deleted_at", null).maybeSingle();
  if (error) throw new LookupError("item_notes", error);
  return (data as NoteRow | null) ?? null;
}

const GONE = "That note no longer exists. Reload to see the current notes.";

export async function editNote(client: Db, ctx: CollabCtx, input: Record<string, unknown> | null): Promise<CollabResult> {
  const noteId = typeof input?.noteId === "string" ? input.noteId : "";
  if (!noteId) return collabFail(400, "noteId is required.");
  const parsed = parseNoteBody(input?.body);
  if ("error" in parsed) return collabFail(400, parsed.error);
  if (!canWrite(ctx.role)) return collabFail(403, "Your role in this workspace can read notes but not edit them.");
  const found = await findNote(client, ctx, noteId);
  if (!found) return collabFail(404, GONE);
  if (!isMine(found, ctx)) return collabFail(403, "Only the author can edit a note.");
  const { data, error } = await client.from("item_notes").update({ body: parsed.body, edited_at: new Date().toISOString() }).eq("id", noteId).eq("org_id", ctx.orgId).eq("author_user_id", ctx.userId).select(NOTE_COLUMNS).single();
  if (error) return collabDbFail(error);
  return collabOk(200, { note: view(data as NoteRow, ctx, await namesAfterWrite(client, ctx.orgId)) });
}

export async function deleteNote(client: Db, ctx: CollabCtx, input: { noteId?: string | null }): Promise<CollabResult> {
  const noteId = typeof input.noteId === "string" ? input.noteId : "";
  if (!noteId) return collabFail(400, "noteId is required.");
  const found = await findNote(client, ctx, noteId);
  if (!found) return collabFail(404, GONE);
  if (!mayDelete(found, ctx)) return collabFail(403, "Only the author, or a workspace owner or admin, can delete a note.");
  const { error } = await client.from("item_notes").update({ deleted_at: new Date().toISOString() }).eq("id", noteId).eq("org_id", ctx.orgId);
  if (error) return collabDbFail(error);
  return collabOk(200, { success: true });
}

type Ctx = { params: Promise<{ id: string }> };
const NAME = "/api/workspace/items/[id]/notes";

export const GET = route<Ctx>(NAME, (request, context) => runCollab(request, context, (client, ctx) => listNotes(client, ctx)));
export const POST = route<Ctx>(NAME, (request, context) => runCollab(request, context, async (client, ctx) => addNote(client, ctx, await readJsonObject(request))));
export const PATCH = route<Ctx>(NAME, (request, context) => runCollab(request, context, async (client, ctx) => editNote(client, ctx, await readJsonObject(request))));
export const DELETE = route<Ctx>(NAME, (request, context) => runCollab(request, context, (client, ctx) => deleteNote(client, ctx, { noteId: new URL(request.url).searchParams.get("noteId") })));
