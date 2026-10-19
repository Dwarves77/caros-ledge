// The one exit-code contract of every runtime and check script that needs credentials (turn, live checks, generator pins, the cutover dry run, the run frame). A run that cannot proceed for lack of a secret is a
// SKIP (exit 2) only when the event that started it cannot carry secrets at all, a pull request from a fork; everywhere else it is a FAILURE (exit 1) that names the missing environment names, never a value. A
// workstation without credentials may skip (nothing was promised), unless the caller named what it wanted. The workflow converts nothing: a green job means the check ran or the event could not run it.
import { appendFileSync, readFileSync } from "node:fs";

type Env = Record<string, string | undefined>;

export const EXIT = Object.freeze({ ok: 0, failed: 1, skipped: 2 } as const);
export type Exit = (typeof EXIT)[keyof typeof EXIT];

export const isCi = (env: Env): boolean => env.CI === "true" || env.GITHUB_ACTIONS === "true";

/** The event payload GitHub wrote for this run, or null when there is none (a workstation) or it cannot be read as JSON. */
function eventPayload(env: Env): { pull_request?: { head?: { repo?: { fork?: boolean } } } } | null {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return null; // an unreadable payload cannot prove the event is a fork's, so the run is treated as one that can carry secrets
  }
}

/** True for the one event that never receives repository secrets: a pull request whose head repository is a fork. */
export function eventCannotCarrySecrets(env: Env): boolean {
  return env.GITHUB_EVENT_NAME === "pull_request" && eventPayload(env)?.pull_request?.head?.repo?.fork === true;
}

export interface Verdict {
  exit: Exit;
  /** The line the script prints. */
  message: string;
}

/**
 * What a run does when `missing` environment names are not set. Nothing missing is `ok`. A fork PR skips (2) and lists the names; any other CI event fails (1) and lists them; a workstation skips (2) unless
 * `named` (the caller asked for this check or stage by name, and a named thing that cannot run has failed).
 */
export function skipVerdict(env: Env, missing: readonly string[], named = false): Verdict {
  if (missing.length === 0) return { exit: EXIT.ok, message: "" };
  const list = missing.join(", ");
  if (eventCannotCarrySecrets(env)) return { exit: EXIT.skipped, message: `self-skipped (exit 2): a pull request from a fork cannot carry secrets; not set: ${list}` };
  if (isCi(env) || named) return { exit: EXIT.failed, message: `missing (exit 1): ${list}. A run that can carry these and does not have them has not run; it is a failure, never a skip` };
  return { exit: EXIT.skipped, message: `self-skipped (exit 2): not set here: ${list}` };
}

/** Append the verdict to the job summary when there is one, so a red run names the missing secrets where the reader looks. */
export function summarise(env: Env, title: string, verdict: Verdict): void {
  if (env.GITHUB_STEP_SUMMARY && verdict.message) appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${verdict.message}\n`);
}
