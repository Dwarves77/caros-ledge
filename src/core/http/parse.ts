// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 6-8)
// Ported from old_repo/src/app/api/orgs/[org_id]/invitations/route.ts (lines 23-41)
import { z } from "zod";

import { HttpError } from "./http-error";

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
  if (!parsed.success) throw new HttpError(400, ((issue = "invalid") => `Invalid ${what}: ${issue}`)(parsed.error.issues[0]?.message));
  return parsed.data;
}

/** The largest request body any route reads: the platform's own limit for a function request (4.5 MB on Vercel) less headroom; the biggest legitimate body today is a bulk import of 1,000,000 characters. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/** The body as text, read in chunks and refused with a 413 the moment it passes the cap: a declared length over the cap is refused before a byte is read, and a body that lies about its length is stopped as it streams. */
async function readBoundedText(request: Request): Promise<string> {
  const refuse = () => new HttpError(413, `Request body is larger than ${MAX_REQUEST_BODY_BYTES} bytes`);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) throw refuse();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    total += part.value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw refuse();
    }
    chunks.push(part.value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** A JSON body validated with zod; a body that is not JSON or does not match is a 400, one over MAX_REQUEST_BODY_BYTES a 413. */
export async function parseJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const text = await readBoundedText(request);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  return parseWith(schema, body, "body");
}
