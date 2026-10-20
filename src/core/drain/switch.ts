// Ported from old_repo/scripts/drain/switch.mjs (lines 1-60)
// The judgement drain's kill switches, read first and failing closed: emergency pause, fleet-budget-halt flag, then the drain switch itself (INV-106).
import type { Db } from "@/core/db";

export interface DrainSwitchState {
  on: boolean;
  reason: string | null;
  judgementDrain: "off" | "on";
  emergencyPaused: boolean;
  fleetHalted: boolean;
  readFailed: boolean;
}

/** Pure. Order of the reason: emergency stop, fleet halt, switch. Anything but a clean `false` for the halt counts as a halt. */
function decideDrainSwitch(reads: { judgementDrain: unknown; emergencyPaused: unknown; fleetHalted: unknown; readFailed?: boolean }): DrainSwitchState {
  const judgementDrain = reads.judgementDrain === "on" ? "on" : "off";
  const emergencyPaused = reads.emergencyPaused === true;
  const fleetHalted = reads.fleetHalted !== false;
  const readFailed = reads.readFailed === true;
  let reason: string | null = null;
  if (emergencyPaused) reason = "emergency pause is set (global_processing_paused)";
  else if (fleetHalted) reason = readFailed ? "fleet-budget-halt could not be read (failing closed)" : "fleet-budget-halt is open";
  else if (judgementDrain !== "on") reason = "judgement_drain is off";
  return { on: reason === null, reason, judgementDrain, emergencyPaused, fleetHalted, readFailed };
}

/** Read the switches through the service client. A missing client or any failed read is a halt. */
export async function readDrainSwitch(sb: Db | null): Promise<DrainSwitchState> {
  if (!sb) return decideDrainSwitch({ judgementDrain: "off", emergencyPaused: false, fleetHalted: true, readFailed: true });
  const state = await sb.from("system_state").select("judgement_drain, global_processing_paused").eq("id", true).maybeSingle();
  const halt = await sb.from("integrity_flags").select("id").eq("subject_ref", "fleet-budget-halt").eq("status", "open").limit(1);
  const row = state.data as { judgement_drain?: unknown; global_processing_paused?: unknown } | null;
  return decideDrainSwitch({
    judgementDrain: row?.judgement_drain,
    emergencyPaused: row?.global_processing_paused,
    fleetHalted: halt.error ? true : (halt.data ?? []).length > 0,
    readFailed: Boolean(state.error || halt.error),
  });
}
