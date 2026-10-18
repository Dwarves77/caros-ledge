// Ported from old_repo/src/app/api/community/groups/route.ts (lines 7-130)
// POST /api/community/groups: a member creates a public vertical group. The group and its owner-admin row are one transaction (create_group_for_self, INV-238), so there is no orphan to roll back; a taken slug is
// retried with a new suffix.
import { z } from "zod";

import { dbError, HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { slugify } from "@/core/shared/text";
import { ALL_SECTORS } from "@/core/workspace/vocabulary";

import { LIMITS } from "../lib/labels";

const SECTOR_IDS = new Set(ALL_SECTORS.map((s) => s.id));
const body = z.object({
  name: z.string().trim().min(1, "A group needs a name").max(LIMITS.groupName, `A group name is at most ${LIMITS.groupName} characters`),
  vertical: z.string().refine((v) => SECTOR_IDS.has(v), "Choose a cargo vertical from the list"),
  description: z.string().trim().max(LIMITS.groupDescription, `A description is at most ${LIMITS.groupDescription} characters`).optional(),
});

export const POST = route("/api/community/groups", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const input = await parseJson(request, body);
  const fragment = slugify(input.name) || "group";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = `grp-${input.vertical}-${fragment}-${crypto.randomUUID().slice(0, 5)}`.slice(0, 80);
    const { data, error } = await auth.client.rpc("create_group_for_self", { p_name: input.name, p_slug: slug, p_vertical: input.vertical, p_description: input.description ?? null });
    if (!error) return ok(auth.headers, { group: data }, 201);
    if (error.code !== "23505") throw dbError(error, { forbidden: "You can't create a group" });
  }
  throw new HttpError(409, "That group name is busy at the moment. Try again.");
});
