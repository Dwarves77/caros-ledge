// New in R2e (M5). The member's own account: DELETE it and GET everything held about it. Both act on the SESSION and nothing else: neither takes an id, so there is no other member's account to name (a body that tries is a 400),
// and both are one database function each (delete_own_account, export_own_account: migration 0104) behind the same per-user limit as the identity route. The export answers through the typed schema (lib/account-export.ts).
import { z } from "zod";

import { isMissingObject } from "@/core/db/absent";
import { dbError, HttpError, LookupError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";
import { parseJson, parseWith } from "@/core/http/parse";
import { log } from "@/core/shared/log";

import { accountExport } from "../lib/account-export";
import { DELETE_PHRASE } from "../lib/account-phrase";

const OWN_REFUSALS = new Set(["42501", "22023"]);
const notYet = () => new HttpError(503, "This is not available just now. Try again shortly.", { "Retry-After": "30" });

/**
 * DELETE /api/account: the caller's account, profile, memberships and the rest of their rows, in one transaction with one event. What they wrote in Community stays under "a deleted member"; a group they owned goes to its next
 * admin; an organisation they were the only member of goes with them; the only owner of an organisation others belong to is refused with the sentence saying why. The session is then closed.
 */
export const DELETE = route("/api/account", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  await parseJson(request, z.strictObject({ confirm: z.literal(DELETE_PHRASE, { error: `Type "${DELETE_PHRASE}" to confirm.` }) }));
  const { data, error } = await user.client.rpc("delete_own_account");
  if (isMissingObject(error)) throw notYet();
  if (error) throw OWN_REFUSALS.has(error.code ?? "") ? dbError(error) : new LookupError("delete_own_account", error);
  try {
    await user.client.auth.signOut();
  } catch (e) {
    log.warn("[account] the account was deleted but its session could not be closed here:", e instanceof Error ? e.message : String(e));
  }
  return ok(user.headers, { deleted: true, ...(data as Record<string, unknown>) });
});

/** GET /api/account/export: the caller's own rows as one JSON file. */
export const GET_EXPORT = route("/api/account/export", async (request) => {
  const user = await requireUser(request);
  if (isRefusal(user)) return user;
  const { data, error } = await user.client.rpc("export_own_account");
  if (isMissingObject(error)) throw notYet();
  if (error) throw OWN_REFUSALS.has(error.code ?? "") ? dbError(error) : new LookupError("export_own_account", error);
  const body = parseWith(accountExport, data, "export");
  return ok({ ...user.headers, "cache-control": "no-store", "content-disposition": 'attachment; filename="caros-ledge-account-export.json"' }, body);
});
