// Ported from old_repo/src/app/api/workspace/portfolios/route.ts (lines 18-37)
import { z } from "zod";

import { ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { createPortfolio, listPortfolios } from "../portfolio/core";

const nameBody = z.object({ name: z.unknown() });

// /api/workspace/portfolios (migration 362). GET: the workspace's portfolios, newest first, each with its member count (a viewer may read).
// POST { name }: create; a case-insensitive duplicate name returns the EXISTING portfolio with `existed: true`. The org comes from the
// session; a viewer reads portfolios but does not write them.
export const GET = route("/api/workspace/portfolios", async (request) => {
  const auth = await requireOrgRole(request, "viewer");
  if (isRefusal(auth)) return auth;
  return ok(auth.headers, { portfolios: await listPortfolios(auth.client, auth.membership.orgId) });
});

export const POST = route("/api/workspace/portfolios", async (request) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, nameBody);
  const result = await createPortfolio(auth.client, { orgId: auth.membership.orgId, userId: auth.userId, name: input.name });
  return ok(auth.headers, result, result.existed ? 200 : 201);
});
