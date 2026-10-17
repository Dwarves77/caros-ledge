// Ported from old_repo/src/app/admin/page.tsx (lines 20-186)
import { boundedRead, exactCount, qb } from "@/core/db";
import type { Db } from "@/core/db";
import { log } from "@/core/shared";

import { countLiveFactors } from "../api/runtime";
import { readAttention, type AttentionCounts } from "../api/attention";

import { readProvisional, readSources, type AdminProvisional, type AdminSource } from "./sources";

/** One part of the console's first paint: its data, or the reason it could not be read. A part that failed renders its own failure note with Retry; the others still render, and nothing renders as zero for want of a read. */
export type Part<T> = { ok: true; data: T } | { ok: false; error: string };
async function part<T>(name: string, read: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, data: await read() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn(`[admin] ${name} could not be read:`, error);
    return { ok: false, error };
  }
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string | null;
  plan: string | null;
  created_at: string;
}
export interface MemberRow {
  id: string;
  org_id: string;
  user_id: string;
  role: string;
  created_at: string;
  user: { full_name: string | null; display_name: string | null; email: string | null; avatar_url: string | null } | null;
}
export interface StagedRow {
  id: string;
  update_type: string;
  created_at: string;
  reason: string | null;
  proposed_changes: Record<string, unknown> | null;
  status: string;
}
export interface DashboardData {
  sources: Part<AdminSource[]>;
  provisional: Part<AdminProvisional[]>;
  orgs: Part<OrgRow[]>;
  members: Part<{ rows: MemberRow[]; capped: boolean }>;
  staged: Part<{ rows: StagedRow[]; total: number }>;
  attention: Part<AttentionCounts>;
  counts: Part<{ held: number; factors: number; disagreements: number; harnessRuns: number; errors: number }>;
}
export const MEMBER_BOUND = 200;
export const STAGED_BOUND = 100;

/** The start of the UTC month an instant falls in. Pure. */
export const monthStart = (nowIso: string): string => `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;

/** Every read the console's first paint needs, each on the one service client behind the admin gate, each failing on its own. `nowIso` is the one server instant of the request. */
export async function readDashboard(db: Db, nowIso: string): Promise<DashboardData> {
  const [sources, provisional, orgs, members, staged, attention, counts] = await Promise.all([
    part("sources", () => readSources(db)),
    part("provisional sources", () => readProvisional(db)),
    part("organizations", async () => {
      const r = await boundedRead<OrgRow>((n) => db.from("organizations").select("id, name, slug, plan, created_at").order("created_at", { ascending: true }).order("id", { ascending: true }).limit(n), { limit: 200 });
      if (r.error) throw new Error(r.error.message);
      return r.data;
    }),
    part("members", async () => {
      const service = db;
      const r = await boundedRead<MemberRow>((n) => qb<MemberRow>(service.from("org_memberships").select("id, org_id, user_id, role, created_at, user:profiles!user_id(full_name, display_name, email, avatar_url)")).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(n), { limit: MEMBER_BOUND });
      if (r.error) throw new Error(r.error.message);
      return { rows: r.data, capped: r.truncated };
    }),
    part("staged updates", async () => {
      const r = await boundedRead<StagedRow>((n) => qb<StagedRow>(db.from("staged_updates").select("id, update_type, created_at, reason, proposed_changes, status")).eq("status", "pending").order("created_at", { ascending: false }).order("id", { ascending: true }).limit(n), { limit: STAGED_BOUND });
      if (r.error) throw new Error(r.error.message);
      return { rows: r.data, total: await exactCount(qb(db.from("staged_updates").select("id", { count: "exact", head: true })).eq("status", "pending")) };
    }),
    part("attention counts", () => readAttention(db)),
    part("counts", async () => {
      const dis = await db.rpc("get_tier_opinion_disagreements", { window_days: 90 });
      if (dis.error) throw new Error(dis.error.message);
      const [held, factors, harnessRuns, errors] = await Promise.all([
        exactCount(qb(db.from("intelligence_items").select("id", { count: "exact", head: true })).eq("is_archived", false).neq("provenance_status", "verified")),
        countLiveFactors(db),
        exactCount(qb(db.from("harness_runs").select("id", { count: "exact", head: true })).gte("started_at", monthStart(nowIso))),
        exactCount(db.from("error_events").select("id", { count: "exact", head: true })),
      ]);
      return { held, factors, disagreements: Array.isArray(dis.data) ? dis.data.length : 0, harnessRuns, errors };
    }),
  ]);
  return { sources, provisional, orgs, members, staged, attention, counts };
}
