// Ported from old_repo/src/app/api/community/moderation/reports/route.ts (lines 9-278)
// Ported from old_repo/src/app/api/community/moderation/reports/[id]/route.ts (lines 12-415)
// Reports: list (row policy: the reports you filed, those on posts in groups you moderate, every one for a platform admin; the status and reason filters are in the query and the page cursor is honest), file a report
// (members of the post's group only), and act on one. The action is moderate_report (INV-239): the reviewer gate, the side effect, the ban record and the close are one transaction in the database, so a refused call
// changes nothing and a raced second action does nothing. The author to notify is returned to this route only and goes through the outbox; a failed queue is reported, never undoes the action.
import { z } from "zod";

import { readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import { serviceClient } from "@/core/db/clients";
import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { queueNotifications } from "@/core/notifications";
import { log } from "@/core/shared/log";

import { LIMITS, REPORT_REASON_IDS } from "../lib/labels";
import type { GroupRole, ModerationReportView } from "../lib/types";

import { cursorParam, idField, isReviewerRole, limitParam, many, one } from "./_http";

/** The date a mute ends, as the database words it in its own refusal ("24 Oct 2026"). */
const mutedDate = (iso: string): string => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const STATUSES = ["open", "resolved", "dismissed"] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const REPORT_COLUMNS = "id, target_kind, target_id, reporter_user_id, reason, body, action, notes, status, created_at, resolved_at";
type ReportRow = Omit<ModerationReportView, "post"> & { reporter_user_id: string | null };

export const GET_REPORTS = route("/api/community/moderation/reports", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const reason = url.searchParams.get("reason");
  if (status && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join(", ")}`);
  if (reason && !REPORT_REASON_IDS.includes(reason)) throw new HttpError(400, "That reason is not one of the report reasons");
  const limit = limitParam(url, DEFAULT_LIMIT, MAX_LIMIT);
  const before = cursorParam(url, "before");
  let query = auth.client.from("moderation_reports").select(REPORT_COLUMNS).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1);
  if (status) query = query.eq("status", status);
  if (reason) query = query.eq("reason", reason);
  if (before) query = query.lt("created_at", before);
  const rows = await many<ReportRow>(query, "reports");
  const page = rows.slice(0, limit);
  const postIds = page.filter((r) => r.target_kind === "post").map((r) => r.target_id);
  const posts = postIds.length ? await many<{ id: string; group_id: string; title: string | null; body: string; created_at: string }>(auth.client.from("community_posts").select("id, group_id, title, body, created_at").in("id", postIds), "reported posts") : [];
  const postById = new Map(posts.map((p) => [p.id, p]));
  const groupIds = [...new Set(posts.map((p) => p.group_id))];
  const groups = groupIds.length ? await many<{ id: string; name: string }>(auth.client.from("community_groups").select("id, name").in("id", groupIds), "groups") : [];
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  // Who may act on which report, so the queue draws action buttons only where they would work: a moderator or admin of the report's group, or a platform admin. The database decides again when the action is taken.
  const myRoles = groupIds.length ? await many<{ group_id: string; role: string }>(auth.client.from("community_group_members").select("group_id, role").eq("user_id", auth.userId).in("group_id", groupIds), "your roles") : [];
  const reviewerOf = new Set(myRoles.filter((m) => isReviewerRole(m.role as GroupRole)).map((m) => m.group_id));
  const admin = page.length ? await readOwnPlatformAdmin(auth.client) : false;
  const reports = page.map(({ reporter_user_id, ...r }) => {
    const post = r.target_kind === "post" ? (postById.get(r.target_id) ?? null) : null;
    return { ...r, is_mine: reporter_user_id === auth.userId, can_review: admin || (post ? reviewerOf.has(post.group_id) : false), group_name: post ? (groupName.get(post.group_id) ?? null) : null, post: post ? { id: post.id, group_id: post.group_id, title: post.title, excerpt: post.body.slice(0, 280), created_at: post.created_at } : null };
  });
  return ok(auth.headers, { reports, next_cursor: rows.length > limit ? (page[page.length - 1]?.created_at ?? null) : null });
});

const file = z.object({
  post_id: idField("post"),
  reason: z.string().trim().toLowerCase().refine((r) => REPORT_REASON_IDS.includes(r), "Choose a reason from the list"),
  body: z.string().trim().max(LIMITS.reportBody, `Details are at most ${LIMITS.reportBody} characters`).optional(),
});

export const POST_REPORT = route("/api/community/moderation/reports", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, file);
  const post = await one<{ id: string; group_id: string }>(auth.client.from("community_posts").select("id, group_id").eq("id", input.post_id).maybeSingle(), "post");
  if (!post) throw new HttpError(404, "Post not found");
  const membership = await one<{ user_id: string }>(auth.client.from("community_group_members").select("user_id").eq("group_id", post.group_id).eq("user_id", auth.userId).maybeSingle(), "membership");
  if (!membership) throw new HttpError(403, "Only members of this group can report its posts");
  const { data, error } = await auth.client.from("moderation_reports").insert({ target_kind: "post", target_id: input.post_id, reporter_user_id: auth.userId, reason: input.reason, body: input.body || null, status: "open" }).select("id").maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't report this post" });
  return ok(auth.headers, { ok: true, report_id: data?.id ?? null }, 201);
});

const act = z.object({ action: z.enum(["dismiss", "warn", "remove", "mute", "ban"]), days: z.number().int().optional(), notes: z.string().trim().max(LIMITS.moderationNote, `A note is at most ${LIMITS.moderationNote} characters`).optional() });
const NOTICE: Record<string, (group: string, notes: string | null) => { title: string; body: string }> = {
  warn: (g, n) => ({ title: `A moderator warned you in ${g}`, body: n ?? "Please read the group's guidelines before you post again." }),
  mute: (g, n) => ({ title: `A moderator muted you in ${g}`, body: n ?? "You can read the group but not post until the mute ends." }),
  remove: (g, n) => ({ title: `A moderator removed your post from ${g}`, body: n ?? "The post was reported and reviewed." }),
  ban: (g, n) => ({ title: `You were banned from ${g}`, body: n ?? "You can no longer join this group." }),
};

export const POST_ACT = route("/api/community/moderation/reports/[id]", async (request, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const { id } = await ctx.params;
  const reportId = idField("report").safeParse(id);
  if (!reportId.success) throw new HttpError(400, "That report is not valid");
  const input = await parseJson(request, act);
  if (input.action === "mute" && ![1, 7, 30].includes(input.days ?? 0)) throw new HttpError(400, "A mute lasts 1, 7 or 30 days");
  const { data, error } = await auth.client.rpc("moderate_report", { p_report_id: reportId.data, p_action: input.action, p_notes: input.notes || null, p_days: input.action === "mute" ? (input.days ?? null) : null });
  if (error) throw dbError(error, { forbidden: "Moderator or platform admin access required", notFound: "Report not found" });
  const done = data as { report_id: string; status: string; action: string; group_id: string | null; notify_user_id: string | null; muted_until: string | null };
  let notified = true;
  const notice = NOTICE[done.action];
  if (notice && done.notify_user_id && done.group_id) {
    const group = await one<{ name: string; slug: string }>(serviceClient().from("community_groups").select("name, slug").eq("id", done.group_id).maybeSingle(), "group");
    const text = notice(group?.name ?? "the group", input.notes || null);
    if (done.action === "mute" && done.muted_until) text.title = `${text.title} until ${mutedDate(done.muted_until)}`;
    const queued = await queueNotifications([{ userId: done.notify_user_id, kind: "moderation", payload: { ...text, link: done.action === "ban" ? "/community/browse" : `/community/${group?.slug ?? ""}`, group_id: done.group_id, report_id: done.report_id } }]);
    if (queued) log.warn("[community] the action was taken but its notification was not queued:", queued);
    notified = queued === null;
  }
  return ok(auth.headers, { ok: true, report_id: done.report_id, status: done.status, action: done.action, muted_until: done.muted_until ?? null, notified });
});
