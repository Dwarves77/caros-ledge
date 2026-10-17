// Ported from old_repo/src/app/api/admin/sources/pause-global/route.ts (lines 10-128)
import { z } from "zod";

import type { Db } from "@/core/db";
import { nextScrapeDate, type ScrapeCadence } from "@/core/fetch/hold";
import { HttpError, LookupError, dbError } from "@/core/http/errors";
import { parseJson } from "@/core/http/parse";

import { adminRoute, reply } from "./shared";

interface StateRow {
  scrape_cadence?: string | null;
  scrape_start_date?: string | null;
  global_processing_paused?: boolean | null;
  judgement_drain?: string | null;
  updated_at?: string | null;
}

/** The hold as the console shows it (rule 16: build mode holds the cadence off). Pure. */
export function holdState(row: StateRow | null | undefined, now: Date) {
  const cadence = (row?.scrape_cadence as ScrapeCadence | undefined) ?? "off";
  const startDate = row?.scrape_start_date ?? null;
  const next = nextScrapeDate({ cadence, startDate }, now);
  return { paused: !!row?.global_processing_paused, judgement_drain: row?.judgement_drain === "on" ? "on" : "off", cadence, start_date: startDate, next_scrape: next ? next.toISOString().slice(0, 10) : null, updated_at: row?.updated_at ?? null };
}

export async function readHold(db: Db, now: Date) {
  const { data, error } = await db.from("system_state").select("scrape_cadence, scrape_start_date, global_processing_paused, judgement_drain, updated_at").eq("id", true).maybeSingle();
  if (error) throw new LookupError("system_state", error);
  return holdState(data as StateRow | null, now);
}

export const GET = adminRoute("/api/admin/sources/pause-global", async (admin) => reply(admin, await readHold(admin.service(), new Date())));

const body = z.object({ paused: z.boolean().optional(), cadence: z.enum(["off", "weekly", "monthly"]).optional(), start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(), judgement_drain: z.enum(["off", "on"]).optional() });

/**
 * The hold switch. This route NEVER writes system_state itself: the pause flags have ONE writer, the admin_set_pause_state rpc (and the judgement drain its own, admin_set_judgement_drain),
 * which declares the marker the guard trigger requires (INV-134). Weekly and monthly need an anchor (today when none is given); off keeps the saved anchor unless the caller clears it with null.
 */
export const POST = adminRoute("/api/admin/sources/pause-global", async (admin, request) => {
  const b = await parseJson(request, body);
  if (b.paused === undefined && b.cadence === undefined && b.judgement_drain === undefined) throw new HttpError(400, "provide `cadence` (off|weekly|monthly), `paused` (boolean) and/or `judgement_drain` (off|on)");
  const db = admin.service();
  const now = new Date();
  if (b.paused !== undefined || b.cadence !== undefined) {
    const anchored = b.cadence !== undefined && b.cadence !== "off";
    const { error } = await db.rpc("admin_set_pause_state", { p_actor: `admin:${admin.userId}`, p_paused: b.paused ?? null, p_cadence: b.cadence ?? null, p_start_date: anchored ? (b.start_date ?? now.toISOString()).slice(0, 10) : null, p_clear_start: b.cadence === "off" && b.start_date === null });
    if (error) throw dbError(error);
  }
  if (b.judgement_drain !== undefined) {
    const { error } = await db.rpc("admin_set_judgement_drain", { p_actor: `admin:${admin.userId}`, p_state: b.judgement_drain });
    if (error) throw dbError(error);
  }
  return reply(admin, { success: true, ...(await readHold(db, now)) });
});
