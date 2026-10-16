// Ported from old_repo/src/app/api/workspace/portfolios/[id]/members/route.ts (lines 24-63)
import { z } from "zod";

import { serviceClient } from "@/core/db/clients";
import { ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { addMember, removeMember } from "../portfolio/core";

import { itemUuidOr404 } from "./shared";

type Ctx = { params: Promise<{ id: string }> };
const NAME = "/api/workspace/portfolios/[id]/members";
const memberBody = z.looseObject({ itemId: z.string().optional(), entityId: z.string().optional() });

// POST adds ONE held thing: { itemId } (a uuid or a legacy id) or { entityId } (cl:<kind>:<id>). Adding what is already a member answers 200 with
// `existed: true`. DELETE removes ONE member (same body); removing what is absent is not an error. A selection of held things, never
// customer-entered data (ADR-042). The org comes from the session.
/** The legacy-id form of itemId resolves to the uuid first (the same helper the tag routes use). */
async function normalised(body: z.infer<typeof memberBody>) {
  if (typeof body.itemId === "string" && body.itemId.length > 0) return { ...body, itemId: await itemUuidOr404(serviceClient(), body.itemId) };
  return body;
}

export const POST = route<Ctx>(NAME, async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await normalised(await parseJson(request, memberBody));
  const result = await addMember(serviceClient(), { orgId: auth.membership.orgId, userId: auth.userId, portfolioId: (await params).id, input });
  return ok(auth.headers, result, result.existed ? 200 : 201);
});

export const DELETE = route<Ctx>(NAME, async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await normalised(await parseJson(request, memberBody));
  await removeMember(serviceClient(), { orgId: auth.membership.orgId, portfolioId: (await params).id, input });
  return ok(auth.headers, {});
});
