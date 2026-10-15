// Ported from old_repo/src/lib/orgs/create-org.mjs (lines 1-112)
// Ported from old_repo/src/app/api/orgs/route.ts (lines 8-62)
// Ported from old_repo/src/app/api/orgs/[org_id]/route.ts (lines 8-8)
// Ported from old_repo/src/app/api/orgs/[org_id]/route.ts (lines 105-223)
import { z } from "zod";

import type { Db } from "@/core/db/clients";
import { HttpError } from "@/core/http/errors";

import { ensureProfile } from "./ensure-profile";

const ORG_SIZE_KEY = "org_size";
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const names = z.array(z.string().min(1).max(80)).max(40).default([]);

/**
 * The create-organisation body. Vocabulary membership (sector ids, regions, size bands) belongs to the workspace slice (P2-02),
 * which passes the sets in `vocab`; until then only the shape is checked.
 */
export function createOrgBody(vocab: { sectors?: ReadonlySet<string>; regions?: ReadonlySet<string>; headcountBands?: ReadonlySet<string> } = {}) {
  const within = (set: ReadonlySet<string> | undefined, what: string) => (list: string[], ctx: z.RefinementCtx) => {
    if (set && list.some((v) => !set.has(v))) ctx.addIssue({ code: "custom", message: `One of the selected ${what} is not recognised.` });
  };
  return z.object({
    name: z.string().trim().min(1, "Organisation name is required.").max(200, "Organisation name must be 200 characters or fewer."),
    sectors: names.superRefine(within(vocab.sectors, "sectors")).transform((l) => [...new Set(l)]),
    regions: names.superRefine(within(vocab.regions, "regions")).transform((l) => [...new Set(l)]),
    headcount_band: z.string().max(40).nullish().refine((b) => !b || !vocab.headcountBands || vocab.headcountBands.has(b), "The selected company size is not recognised."),
    job_title: z.string().trim().max(120, "Job title must be 120 characters or fewer.").nullish(),
  });
}
export type CreateOrgInput = z.infer<ReturnType<typeof createOrgBody>>;

/** Create an organisation for the caller (the rpc makes them owner and seeds workspace_settings), then patch sectors, size, region and job title. A patch that fails is reported, not hidden. */
export async function createOrgForSelf(client: Db, user: { id: string; email: string | null }, input: CreateOrgInput): Promise<{ orgId: string; slug: string | null; name: string; settingsSaved: boolean; profileSaved: boolean }> {
  if (!(await ensureProfile(user.id, user.email)).exists) throw new HttpError(500, "Your profile could not be prepared. Try again in a moment.");
  const { data: orgId, error: rpcError } = await client.rpc("create_org_for_self", { p_org_name: input.name, p_org_slug: null });
  if (rpcError || !orgId) throw new HttpError(400, rpcError?.message || "The organisation could not be created.");

  let settingsSaved = true;
  const patch: Record<string, unknown> = {};
  if (input.sectors.length) patch.sector_profile = input.sectors;
  if (input.headcount_band) {
    const { data: row, error } = await client.from("workspace_settings").select("profile").eq("org_id", orgId).maybeSingle();
    if (error) settingsSaved = false;
    else {
      const current = row?.profile && typeof row.profile === "object" ? (row.profile as Record<string, unknown>) : {};
      const size = current[ORG_SIZE_KEY] && typeof current[ORG_SIZE_KEY] === "object" ? (current[ORG_SIZE_KEY] as Record<string, unknown>) : {};
      patch.profile = { ...current, [ORG_SIZE_KEY]: { ...size, headcount_band: input.headcount_band } };
    }
  }
  if (Object.keys(patch).length && (await client.from("workspace_settings").update(patch).eq("org_id", orgId)).error) settingsSaved = false;

  let profileSaved = true;
  const profilePatch: Record<string, unknown> = {};
  if (input.job_title) profilePatch.job_title = input.job_title;
  if (input.regions.length) profilePatch.region = input.regions;
  if (Object.keys(profilePatch).length && (await client.from("profiles").update({ ...profilePatch, updated_at: new Date().toISOString() }).eq("id", user.id)).error) profileSaved = false;

  const { data: org, error: orgError } = await client.from("organizations").select("id, name, slug").eq("id", orgId).maybeSingle();
  return { orgId: String(orgId), slug: orgError ? null : (org?.slug ?? null), name: org?.name ?? input.name, settingsSaved, profileSaved };
}

export const renameBody = z.object({
  name: z.string().trim().min(1, "name must be non-empty").max(200, "name must be 200 characters or fewer").optional(),
  slug: z.string().trim().toLowerCase().min(2, "slug must be 2-60 characters").max(60, "slug must be 2-60 characters").regex(SLUG_RE, "slug must contain only lowercase letters, digits, or hyphens; cannot start or end with a hyphen").optional(),
});

/** Owner-only rename or re-slug (the caller's role is checked by the guard). A taken slug is a 409. */
export async function updateOrg(service: Db, orgId: string, patch: z.infer<typeof renameBody>): Promise<Record<string, unknown>> {
  if (patch.name === undefined && patch.slug === undefined) throw new HttpError(400, "Provide at least one of name or slug");
  const { data, error } = await service.from("organizations").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", orgId).select("id, name, slug, plan, created_at, updated_at").maybeSingle();
  if (error) throw new HttpError(error.code === "23505" ? 409 : 500, error.message);
  if (!data) throw new HttpError(404, "org not found");
  return data;
}
