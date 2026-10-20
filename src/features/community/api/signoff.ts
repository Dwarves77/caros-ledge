// Ported from old_repo/src/app/api/community/posts/[id]/signoff/route.ts (lines 23-81)
// Ported from old_repo/src/app/api/community/signoff/[id]/decide/route.ts (lines 31-201)
// Ported from old_repo/src/app/api/community/signoff/[id]/withdraw/route.ts (lines 23-69)
// Verifier sign-off (INV-241): a member requests it (one open request per post, by a unique index), the requester withdraws it, an active verifier or a platform admin decides it. The decision and the post stamp are one
// transaction in decide_signoff, whose first line is the verifier gate (the admin bit comes from is_platform_admin() inside it, never from a column this route reads).
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { LIMITS } from "../lib/labels";

import { idParam } from "./_http";

type Ctx = { params: Promise<{ id: string }> };
const COLUMNS = "id, post_id, requested_by, status, verifier_id, primary_doc_url, decision_note, created_at, decided_at";

export const POST_REQUEST = route("/api/community/posts/[id]/signoff", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const postId = await idParam(ctx, "id", "post id");
  const { data, error } = await auth.client.from("community_post_signoff_requests").insert({ post_id: postId, requested_by: auth.userId, status: "pending" }).select(COLUMNS).maybeSingle();
  if (error) {
    if (error.code === "23505") throw new HttpError(409, "A sign-off request is already open for this post");
    if (error.code === "23503") throw new HttpError(404, "Post not found");
    throw dbError(error, { forbidden: "Only members of this room may ask for a sign-off" });
  }
  if (!data) throw new HttpError(403, "Only members of this room may ask for a sign-off");
  return ok(auth.headers, { request: data }, 201);
});

const decision = z.object({
  decision: z.enum(["signed_off", "declined"]),
  primary_doc_url: z.string().trim().max(2000).nullable().optional(),
  decision_note: z.string().trim().max(LIMITS.decisionNote, `A note is at most ${LIMITS.decisionNote} characters`).nullable().optional(),
});

export const POST_DECIDE = route("/api/community/signoff/[id]/decide", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const requestId = await idParam(ctx, "id", "sign-off request id");
  const input = await parseJson(request, decision);
  if (input.decision === "signed_off" && !input.primary_doc_url) throw new HttpError(400, "A sign-off names the primary document it was checked against.");
  const { data, error } = await auth.client.rpc("decide_signoff", { p_request_id: requestId, p_decision: input.decision, p_primary_doc_url: input.primary_doc_url || null, p_decision_note: input.decision_note || null });
  if (error) throw dbError(error, { forbidden: "Only active verifiers may record a sign-off decision", notFound: "Sign-off request not found" });
  return ok(auth.headers, { request: data });
});

export const POST_WITHDRAW = route("/api/community/signoff/[id]/withdraw", async (request, ctx: Ctx) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const requestId = await idParam(ctx, "id", "sign-off request id");
  const { data, error } = await auth.client.from("community_post_signoff_requests").update({ status: "withdrawn", decided_at: new Date().toISOString() }).eq("id", requestId).eq("requested_by", auth.userId).eq("status", "pending").select(COLUMNS).maybeSingle();
  if (error) throw dbError(error, { forbidden: "You can't withdraw this request" });
  if (!data) throw new HttpError(404, "No open request of yours was found to withdraw");
  return ok(auth.headers, { request: data });
});
