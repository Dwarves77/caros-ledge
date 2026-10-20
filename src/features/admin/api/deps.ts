// Ported from old_repo/src/app/api/admin/run-intake/route.ts (lines 13-50)
import type { Db } from "@/core/db";
import { buildDeps, type BuiltDeps } from "@/core/turn/wiring";

/** The dependency graph the manual dispatches run on: the turn's own, built over the service client. */
export const adminDeps = (db: Db): BuiltDeps => buildDeps(db, process.env);
