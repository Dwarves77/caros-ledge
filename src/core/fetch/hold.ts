// Ported from old_repo/src/lib/sources/fetch-hold.mjs (lines 1-54)
// Ported from old_repo/src/lib/sources/scrape-schedule.ts (lines 1-59)
// Ported from old_repo/src/lib/api/pause.ts (lines 7-50)
import type { Db } from "@/core/db";

export type ScrapeCadence = "off" | "weekly" | "monthly";
export interface ScrapeSchedule {
  cadence: ScrapeCadence;
  /** 'YYYY-MM-DD' anchor (first run and recurrence phase); null means unset (never runs). */
  startDate: string | null;
}
export interface ScrapeState extends ScrapeSchedule {
  /** The independent emergency stop (system_state.global_processing_paused): a hard halt regardless of cadence or caller. */
  emergencyPaused: boolean;
}
const FAIL_CLOSED: ScrapeState = { cadence: "off", startDate: null, emergencyPaused: false };

/** The scrape schedule and emergency stop from the system_state singleton; THROWS on a read error (a reporting driver must tell "off" from "unreadable"). */
export async function readScrapeState(db: Db): Promise<ScrapeState> {
  const { data, error } = await db.from("system_state").select("scrape_cadence, scrape_start_date, global_processing_paused").eq("id", true).maybeSingle();
  if (error) throw new Error(`system_state read failed: ${error.message}`);
  return { cadence: (data?.scrape_cadence as ScrapeCadence | undefined) ?? "off", startDate: (data?.scrape_start_date as string | null | undefined) ?? null, emergencyPaused: !!data?.global_processing_paused };
}
/** The same read, failing CLOSED (a read error counts as off) and saying so: `unreadable` is true when the state is the fail-closed one, so a page can state that the hold is unknown. */
export async function readScrapeStateOrClosed(db: Db): Promise<{ state: ScrapeState; unreadable: boolean }> {
  try {
    return { state: await readScrapeState(db), unreadable: false };
  } catch {
    return { state: FAIL_CLOSED, unreadable: true };
  }
}
/** The fail-closed read every fetch and every dispatcher uses. */
export async function getScrapeState(db: Db): Promise<ScrapeState> {
  return (await readScrapeStateOrClosed(db)).state;
}
/** Scraping is switched off when the cadence is off or the emergency stop is set. */
export async function isGloballyPaused(db: Db): Promise<boolean> {
  const s = await getScrapeState(db);
  return s.cadence === "off" || s.emergencyPaused;
}

/** Exactly two signed callers may pass an engaged hold or a cadence of off (ADR-012 rider, Disposition Unit 0b): no third door. */
const AUTHORIZED_HOLD_CALLERS: ReadonlySet<string> = Object.freeze(new Set(["unit3-remediation", "manual-intake-run"]));
const isAuthorizedHoldCaller = (caller: unknown): boolean => typeof caller === "string" && AUTHORIZED_HOLD_CALLERS.has(caller);

const LIFTED = new Set(["0", "off", "false", "lifted", "no", ""]);
/** Is the env hold (SCRAPE_HOLD) engaged? Unset is lifted; any other unrecognised value counts as engaged (a typo must not open the gate). */
function holdEngaged(env: Record<string, string | undefined> = process.env): boolean {
  return !LIFTED.has(String(env.SCRAPE_HOLD ?? "").trim().toLowerCase());
}

export class FetchHoldError extends Error {
  readonly url: string;
  readonly caller: string | null;
  readonly reason: FetchDecision["reason"];
  constructor(url: string, caller: string | null, reason: FetchDecision["reason"]) {
    super(`FETCH_HOLD_ENGAGED (${reason}): refusing to fetch ${url}${caller ? `; caller '${caller}' is not a signed authorized caller` : ""}. The hold gates autonomous and scheduled fetching.`);
    this.name = "FetchHoldError";
    this.url = url;
    this.caller = caller;
    this.reason = reason;
  }
}
export interface FetchDecision {
  allowed: boolean;
  reason: "lifted" | "signed_caller" | "hold_engaged" | "cadence_off" | "emergency_stop";
}
export interface HoldDeps {
  db: Db;
  env?: Record<string, string | undefined>;
}

/**
 * Whether a fetch of `url` may reach the network (INV-177). Refused while the env hold is engaged or the cadence is off or unreadable, except for
 * one of the two signed callers; the emergency stop refuses everyone. The decision is data: callers that refuse use assertFetchAllowed.
 */
export async function fetchAllowed(_url: string, caller: string | null | undefined, deps: HoldDeps): Promise<FetchDecision> {
  const state = await getScrapeState(deps.db);
  if (state.emergencyPaused) return { allowed: false, reason: "emergency_stop" };
  const engaged = holdEngaged(deps.env);
  if (isAuthorizedHoldCaller(caller)) return { allowed: true, reason: engaged || state.cadence === "off" ? "signed_caller" : "lifted" };
  if (engaged) return { allowed: false, reason: "hold_engaged" };
  if (state.cadence === "off") return { allowed: false, reason: "cadence_off" };
  return { allowed: true, reason: "lifted" };
}
/** Throw FetchHoldError when `fetchAllowed` refuses. Called at the top of every function that reaches the network. */
export async function assertFetchAllowed(url: string, caller: string | null | undefined, deps: HoldDeps): Promise<FetchDecision> {
  const d = await fetchAllowed(url, caller, deps);
  if (!d.allowed) throw new FetchHoldError(url, caller ?? null, d.reason);
  return d;
}

const DAY_MS = 86_400_000;
function parseYmdUtc(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
const startOfUtcDay = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** Is `now` on a scheduled scrape DAY? false when off, unanchored, before the anchor or off an interval boundary. Monthly clamps a short month. */
export function scrapeWindowOpen(s: ScrapeSchedule, now: Date): boolean {
  if (s.cadence === "off" || !s.startDate) return false;
  const start = parseYmdUtc(s.startDate);
  if (!start) return false;
  const today = startOfUtcDay(now);
  if (today.getTime() < start.getTime()) return false;
  if (s.cadence === "weekly") return Math.round((today.getTime() - start.getTime()) / DAY_MS) % 7 === 0;
  const lastDom = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  return today.getUTCDate() === Math.min(start.getUTCDate(), lastDom);
}
/** The next scheduled scrape date at or after `now`; null when off or unset. Bounded to about 400 days. */
export function nextScrapeDate(s: ScrapeSchedule, now: Date): Date | null {
  if (s.cadence === "off" || !s.startDate) return null;
  const start = parseYmdUtc(s.startDate);
  if (!start) return null;
  let cand = startOfUtcDay(now).getTime() < start.getTime() ? new Date(start) : startOfUtcDay(now);
  for (let i = 0; i < 400; i++) {
    if (scrapeWindowOpen(s, cand)) return cand;
    cand = new Date(cand.getTime() + DAY_MS);
  }
  return null;
}
