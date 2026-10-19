// New in R2d: a collab write's database failure as its result (register workspace-admin-community:19): the customer sentence for the failure's class and status, the driver's code and message to the log only.
import { collabFail, type CollabResult } from "@/core/workspace/roster";
import { dbError } from "@/core/http/errors";
import { log } from "@/core/shared/log";

export const collabDbFail = (error: { message: string; code?: string | null }): CollabResult => {
  const e = dbError(error);
  log.warn(`[collab] ${e.status} held back from the response:`, e.message);
  return collabFail(e.status, e.publicMessage);
};
