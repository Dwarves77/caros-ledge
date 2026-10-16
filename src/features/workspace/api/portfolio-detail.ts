// Ported from old_repo/src/app/api/workspace/portfolios/[id]/route.ts (lines 22-56)
import { z } from "zod";

import { HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireOrgRole } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";

import { deletePortfolio, renamePortfolio } from "../portfolio/core";
import { readPortfolioDetail } from "../portfolio/read";

import { workspaceDeps } from "./deps";

type Ctx = { params: Promise<{ id: string }> };
const nameBody = z.object({ name: z.unknown() });
const NAME = "/api/workspace/portfolios/[id]";

// GET one portfolio with its members hydrated, grouped by surface, and the roll-ups computed at read time from held data only (each carries
// its held-over-total denominator). PATCH { name } renames; DELETE removes it and its members. A portfolio id from another workspace
// answers 404, exactly like a missing one: every statement is filtered by the caller's own org.
export const GET = route<Ctx>(NAME, async (request, { params }) => {
  const auth = await requireOrgRole(request, "viewer");
  if (isRefusal(auth)) return auth;
  const deps = workspaceDeps().portfolio;
  if (!deps) throw new LookupError("portfolio read layer", "not wired");
  const view = await readPortfolioDetail(auth.client, auth.membership.orgId, (await params).id, new Date(), deps);
  if (!view) throw new HttpError(404, "Portfolio not found in your workspace");
  return ok(auth.headers, view);
});

export const PATCH = route<Ctx>(NAME, async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, nameBody);
  return ok(auth.headers, { portfolio: await renamePortfolio(auth.client, { orgId: auth.membership.orgId, portfolioId: (await params).id, name: input.name }) });
});

export const DELETE = route<Ctx>(NAME, async (request, { params }) => {
  const auth = await requireOrgRole(request, "member");
  if (isRefusal(auth)) return auth;
  await deletePortfolio(auth.client, { orgId: auth.membership.orgId, portfolioId: (await params).id });
  return ok(auth.headers, {});
});
