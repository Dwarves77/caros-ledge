// Ported from old_repo/src/lib/telemetry/capture-error.ts (lines 1-135)
// Ported from old_repo/src/lib/telemetry/stack-hash.mjs (lines 1-64)
import { createHash } from "node:crypto";

import { serviceClient, type Db } from "@/core/db/clients";

import { log } from "./log";

const MESSAGE_MAX = 1000;
const STACK_MAX = 4000;
const ROUTE_MAX = 300;
const EMAIL_RE = /[^\s@<>()"']+@[^\s@<>()"']+\.[^\s@<>()"']+/g;

export interface CaptureErrorInput {
  side: "server" | "client";
  route: string;
  error: unknown;
  stack?: string | null;
  /** A user uuid only; never an email or a name. */
  userScope?: string | null;
}

function normalise(message: string, stack: string): string {
  const frames = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || l.includes("@"))
    .slice(0, 5)
    .map((l) => l.replace(/\(([^)]*)\)/g, (_, loc: string) => `(${(loc.replace(/:\d+(:\d+)?$/, "").split(/[\\/]/).pop() ?? "")})`).replace(/\s+/g, " "));
  const text = message.slice(0, 500).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#").replace(/\b[0-9a-f]{12,}\b/gi, "#").replace(/\d+/g, "#");
  return `${text.replace(/\s+/g, " ").trim()}\n${frames.join("|")}`;
}

export function stackHash(side: string, message: string, stack: string): string {
  return createHash("sha256").update(`${side}\n${normalise(message, stack)}`, "utf8").digest("hex");
}

let unavailableNoted = false;
/** Test seam: forget that the missing-key line was written. */
export const resetTelemetryNotice = (): void => {
  unavailableNoted = false;
};

/** Write one error_events row (deduplicated by stack hash, release, side and route). No PII is stored: emails in a message are redacted. Never throws. */
export async function captureError(input: CaptureErrorInput, client?: Db): Promise<void> {
  try {
    const raw = input.error instanceof Error ? input.error.message || input.error.name : typeof input.error === "string" ? input.error : JSON.stringify(input.error);
    const message = String(raw).replace(EMAIL_RE, "[email]").slice(0, MESSAGE_MAX);
    const stack = (input.error instanceof Error && input.error.stack ? input.error.stack : (input.stack ?? "")).replace(EMAIL_RE, "[email]");
    const route = (input.route || "").slice(0, ROUTE_MAX);
    const release = process.env.VERCEL_GIT_COMMIT_SHA || "dev";
    const hash = stackHash(input.side, message, stack);
    let db: Db;
    try {
      db = client ?? serviceClient();
    } catch {
      // No service client (a member-only runner, a preview): error_events cannot be written. Said once per process, never once per error.
      if (!unavailableNoted) log.warn("[capture-error] error_events is unavailable: no service key is configured, errors are not stored in this process");
      unavailableNoted = true;
      return;
    }
    const row = { release, env: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown", side: input.side, route, message, stack_hash: hash, stack_excerpt: stack ? stack.slice(0, STACK_MAX) : null, user_scope: input.userScope ?? null };
    const { error } = await db.from("error_events").insert(row);
    if (!error) return;
    if (error.code !== "23505") return log.error("[capture-error] insert failed:", error.message);
    const { data: existing, error: readError } = await db.from("error_events").select("id, count").eq("stack_hash", hash).eq("release", release).eq("side", input.side).eq("route", route).maybeSingle();
    if (readError || !existing) return log.error("[capture-error] dedup select failed:", readError?.message);
    const { error: updateError } = await db.from("error_events").update({ count: (existing.count ?? 1) + 1, last_seen_at: new Date().toISOString() }).eq("id", existing.id);
    if (updateError) log.error("[capture-error] dedup increment failed:", updateError.message);
  } catch (e) {
    log.error("[capture-error] capture threw:", e);
  }
}

/** Wrap a route handler: capture whatever it throws, then re-raise so the platform still answers 500. */
export function withErrorCapture<Req extends Request, Ctx = unknown>(route: string, handler: (request: Req, context: Ctx) => Promise<Response>): (request: Req, context: Ctx) => Promise<Response> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      await captureError({ side: "server", route, error });
      throw error;
    }
  };
}
