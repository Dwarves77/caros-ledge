// New in P2-13: the injection point for the one slice the Assistant reads that is not merged here (WAVE-2-COMMON deps rule), no old counterpart.
import type { Db } from "@/core/db";

/**
 * What the Assistant calls into slices that are not merged. P2-12 supplies the Operations data block (src/features/operations/ask-context.ts): the regional and state-cost facts the question and the
 * hits name, one plain line each with its source. Until it is wired the answer carries no Operations lines and the startup check names the member as owed. It is never faked.
 */
export interface AssistantDeps {
  operationsFacts: (db: Db, input: { question: string; jurisdictions: string[] }) => Promise<string[]>;
}

let wired: Partial<AssistantDeps> = {};

export function wireAssistantDeps(deps: Partial<AssistantDeps>): void {
  wired = { ...wired, ...deps };
}

export function assistantDeps(): Partial<AssistantDeps> {
  return wired;
}
