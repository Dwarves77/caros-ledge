// Ported from old_repo/src/lib/auth/provision-personal-workspace.ts (lines 1-94)
import { serviceClient, type Db } from "@/core/db/clients";
import { log } from "@/core/shared/log";
import { captureError } from "@/core/shared/telemetry";

export interface EnsureProfileResult {
  created: boolean;
  exists: boolean;
  failedStep?: string;
  /** Why the step failed (for a stated 503), when it did. */
  reason?: string;
}

/**
 * INV-154: every signed-in user has a profiles row. Insert it when missing (a unique violation re-reads, so a race is not a failure).
 * The privilege columns are never written here: the row is `role: member` with empty settings. A failure is counted in error_events and returned, never thrown.
 */
export async function ensureProfile(userId: string, email: string | null | undefined, client?: Db): Promise<EnsureProfileResult> {
  const fail = async (step: string, message: string): Promise<EnsureProfileResult> => {
    log.warn(`[ensure-profile] ${step} failed:`, message);
    await captureError({ side: "server", route: "auth/ensure-profile", error: new Error(`ensure-profile failed at ${step}: ${message}`) });
    return { created: false, exists: false, failedStep: step, reason: message };
  };
  try {
    const db = client ?? serviceClient();
    const read = () => db.from("profiles").select("id").eq("id", userId).maybeSingle();
    const { data: existing, error: readError } = await read();
    if (readError) return await fail("profiles_read", readError.message);
    if (existing?.id) return { created: false, exists: true };
    const { error: insertError } = await db.from("profiles").insert({ id: userId, email: email || null, role: "member", settings: {} });
    if (!insertError) return { created: true, exists: true };
    if (insertError.code === "23505") {
      const { data: again, error: againError } = await read();
      if (!againError && again?.id) return { created: false, exists: true };
    }
    return await fail("profiles_insert", insertError.message);
  } catch (e) {
    return await fail("unexpected_exception", e instanceof Error ? e.message : String(e));
  }
}
