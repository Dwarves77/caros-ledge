// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 6-8)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 23-41)
import { z } from "zod";

import { HttpError } from "./errors";

/** The one UUID shape (any 8-4-4-4-12 hex, as the old UUID_RE accepted). */
export const uuid = z.guid();
/** The one email validator: trimmed, lower-cased, then checked. */
export const email = z.string().trim().toLowerCase().pipe(z.email());

export function isUuid(value: unknown): value is string {
  return uuid.safeParse(value).success;
}

/** Validate a value or answer 400 with the first issue. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown, what = "request"): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, `Invalid ${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

/** A JSON body validated with zod; a body that is not JSON or does not match is a 400. */
export async function parseJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parseWith(schema, body, "body");
}
