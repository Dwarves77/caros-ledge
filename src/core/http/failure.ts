// What a customer is told when a database call fails (S5, register core:21 and workspace-admin-community:19, 62): one table of sentences by HTTP status (data/db-sentences.json), the one map from a Postgres or PostgREST
// code to that status, and `readFailure` for the browser-client reads and writes that have no route in between. The driver's message is logged and never returned. No server imports, so a client component can read it.
import { z } from "zod";

import { log } from "@/core/shared/log";

import sentencesJson from "./data/sentences.json";

const TABLE = z.object({ status: z.record(z.string(), z.string().min(1)), refusal: z.record(z.string(), z.string().min(1)) }).parse(sentencesJson);
/** The customer sentence for each status a database failure answers (data/sentences.json, "status"): a driver message is never one of them. */
export const DB_SENTENCES = TABLE.status;
export const LOOKUP_SENTENCE = DB_SENTENCES["503"] as string;

/** Why a read could not answer, as a code a component maps to its stated sentence through the ONE table (data/sentences.json, "refusal"). A failed read returns `{ ok: false, reason }` and never a value. */
export type RefusalReason = keyof typeof sentencesJson.refusal;
export interface Refusal {
  ok: false;
  reason: RefusalReason;
}
export const refusal = (reason: RefusalReason): Refusal => ({ ok: false, reason });
/** The sentence a component draws for a refusal. */
export const refusalSentence = (reason: RefusalReason): string => TABLE.refusal[reason] as string;

/** Codes that mean "the database could not answer now" (timeout, serialisation failure, deadlock, lock or connection limits, the 08 connection class): 503 with Retry-After, not a defect. */
const TRANSIENT = new Set(["57014", "40001", "40P01", "55P03", "53300"]);
/** Codes that mean the request itself was malformed (invalid text representation, not-null, check, length). */
const INVALID = new Set(["22P02", "22001", "23502", "23514"]);

/** Postgres and PostgREST codes to HTTP statuses: the one map. */
export function statusForDb(code: string | null | undefined): number {
  if (code && (TRANSIENT.has(code) || code.startsWith("08"))) return 503;
  if (code && INVALID.has(code)) return 400;
  switch (code) {
    case "42501":
    case "PGRST301":
      return 403;
    case "P0002":
      return 404;
    case "22023":
    case "23505":
      return 409;
    default:
      return 500;
  }
}

/** The table's sentence for a database error. */
const sentenceFor = (error: { code?: string | null }): string => DB_SENTENCES[String(statusForDb(error.code))] ?? (DB_SENTENCES["500"] as string);

/** A failed browser-client read or write as the sentence the page shows: the driver's code and message go to the log. */
export function readFailure(error: { message: string; code?: string | null }): string {
  log.warn(`[client] database ${error.code ?? "error"}:`, error.message);
  return sentenceFor(error);
}
