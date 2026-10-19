// Ported from old_repo/scripts/lib/db.mjs (lines 601-642)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1871-1912)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2988-3006)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3341-3361)
// Ported from old_repo/src/lib/sources/source-growth.ts (lines 81-99)
import type { Db } from "@/core/db";
import { isMissingObject } from "@/core/db";
import { canonicalUrl, hostOf } from "@/core/shared";

import { classifySourceRole } from "./classify";
import { permanentlyUnregisteredClass, placeHostWithVerdicts, type HostVerdictRef } from "./host-class";
import { hostInstitution, institutionKey } from "./institution";
import { reuseTermsForHost } from "./reuse-terms";
import { tierLabelOf } from "./tier-contract";

/** How many exact-host rows the duplicate check reads: the rows of one host are matched by institution key in code, so this is slack for a portal host that holds several institutions. */
const EXACT_HOST_LOOKUP_LIMIT = 25;

/**
 * PostgREST `or` filter selecting registered urls whose host is exactly `hostKey` (lower-case, no www), with or without www, over http or https, as
 * `scheme://host/...` or the bare `scheme://host`. A longer host that merely contains `hostKey` cannot match: after the host comes `/` or the end.
 */
function exactHostUrlFilter(hostKey: string): string {
  const out: string[] = [];
  for (const scheme of ["https", "http"]) {
    for (const prefix of ["", "www."]) out.push(`url.ilike.${scheme}://${prefix}${hostKey}/*`, `url.ilike.${scheme}://${prefix}${hostKey}`);
  }
  return out.join(",");
}

export interface RegistryRow {
  id: string;
  url: string | null;
  base_tier: number | null;
  tier_override: number | null;
  status?: string | null;
  institution_id?: string | null;
  institution_key?: string | null;
}
export type ExactHostLookup = { ok: true; rows: RegistryRow[] } | { ok: false; error: string };

/** The registered rows whose host is exactly the URL's host. A read error is returned as a failure, never as "no match" (B-0227). */
export async function lookupExactHost(db: Db, url: string): Promise<ExactHostLookup> {
  const host = hostOf(url);
  if (!host) return { ok: true, rows: [] };
  const { data, error } = await db.from("sources").select("id, url, base_tier, tier_override, status, institution_id, institution_key").or(exactHostUrlFilter(host)).limit(EXACT_HOST_LOOKUP_LIMIT);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: ((data ?? []) as RegistryRow[]).filter((r) => hostOf(r.url) === host) };
}

/**
 * The registry row that IS this URL's institution: the row at the same canonical URL, else the row whose institution key equals the URL's. Never the first row of the host: on a shared portal (gob.mx, gov.br, nj.gov, gov.pl,
 * nyc.gov) several institutions share one host and each has its own row and tier (register row D:27).
 */
export function pickInstitutionRow<T extends { url: string | null }>(rows: readonly T[], url: string): T | null {
  const canon = canonicalUrl(url);
  const key = institutionKey(url);
  return rows.find((r) => canonicalUrl(r.url) === canon) ?? rows.find((r) => institutionKey(r.url) === key) ?? null;
}

/** The registry row for a URL (see pickInstitutionRow). Null when none; a read error throws. */
export async function readSourceByUrl(db: Db, url: string): Promise<RegistryRow | null> {
  const found = await lookupExactHost(db, url);
  if (!found.ok) throw new Error(`readSourceByUrl failed for ${url}: ${found.error}`);
  return pickInstitutionRow(found.rows, url);
}

/** The registry identity of one PAGE (host, path and query, lower case): the key a source other than an institution's own row is born under. Empty when unparseable. */
function pageKey(url: string | null | undefined): string {
  try {
    const u = new URL(String(url));
    return `${hostOf(url)}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
  } catch {
    return "";
  }
}

/** The named ways a source row is born. They differ only in the values below; the identity, the tier rule and the write are the same one function. */
export type BirthProfile = "class" | "growth" | "candidate" | "promoted";
const PROFILES: Record<BirthProfile, Record<string, unknown>> = {
  class: { status: "active", admin_only: false },
  growth: { status: "provisional", auto_run_enabled: false, admin_only: false },
  candidate: { status: "active", admin_only: false, access_method: "scrape" },
  promoted: { status: "active", admin_only: false, access_method: "scrape" },
};

export interface RegisterInput {
  url: string;
  name?: string | null;
  /** A tier from the class table (never a default: no model output and no default value sets base_tier, INV-176). */
  base_tier: number;
  source_role?: string | null;
  institutionKey?: string;
  profile?: BirthProfile;
  extra?: Record<string, unknown>;
}
/**
 * Register a source, one function for every birth path. The institution's own row (profile `class`) is keyed by institutionKey, any other source by its page; the existing row for the key is found by an indexed read, never by
 * reading the whole registry, and the insert is `register_source_once` (migration 0081), so two workers registering one key make one row. An existing row is re-activated when it is not active. A new row is born with its
 * source_role, the base_tier the caller took from the class table, and the rights verdict the class table fixes for its host.
 */
export async function registerSource(db: Db, source: RegisterInput): Promise<{ source_id: string; created: boolean; host: string }> {
  if (!source?.url) throw new Error("registerSource: source.url required");
  const host = hostOf(source.url);
  if (!host) throw new Error(`registerSource: cannot parse host from ${source.url}`);
  if (!Number.isInteger(source.base_tier) || source.base_tier < 1 || source.base_tier > 7) throw new Error(`registerSource: base_tier ${source.base_tier} is not a tier; a source is never registered at a guessed or defaulted tier`);
  const profile = source.profile ?? "class";
  const key = (source.institutionKey || (profile === "class" ? institutionKey(source.url) : pageKey(source.url))).toLowerCase();
  const reactivate = async (id: string, status: string | null | undefined) => {
    if (status && status !== "active") {
      const { error } = await db.from("sources").update({ status: "active" }).eq("id", id);
      if (error) throw new Error(`registerSource: reactivation of ${id} failed: ${error.message}`);
    }
  };
  const byKey = await db.from("sources").select("id, status").eq("institution_key", key).limit(1);
  if (byKey.error) throw new Error(`registerSource: key read failed for ${key}: ${byKey.error.message}`);
  const keyed = ((byKey.data ?? []) as Array<{ id: string; status: string }>)[0];
  if (keyed) {
    await reactivate(keyed.id, keyed.status);
    return { source_id: keyed.id, created: false, host };
  }
  // A row born before the key existed: the same page, or (for an institution's own row) any row of the same institution.
  const found = await lookupExactHost(db, source.url);
  if (!found.ok) throw new Error(`registerSource: registry lookup failed for ${source.url}: ${found.error}`);
  const sameUrl = await db.from("sources").select("id, url, status").eq("url", source.url).limit(1);
  if (sameUrl.error) throw new Error(`registerSource: url read failed for ${source.url}: ${sameUrl.error.message}`);
  const legacy = ((sameUrl.data ?? []) as Array<{ id: string; status: string }>)[0] ?? (profile === "class" ? found.rows.find((r) => institutionKey(r.url) === key) : found.rows.find((r) => canonicalUrl(r.url) === canonicalUrl(source.url)));
  if (legacy) {
    await reactivate(legacy.id, legacy.status);
    return { source_id: legacy.id, created: false, host };
  }
  const name = source.name || host;
  const row = { name, url: source.url, base_tier: source.base_tier, tier_at_creation: source.base_tier, source_role: source.source_role ?? classifySourceRole(name, source.url), reuse_terms: reuseTermsForHost(source.url), ...PROFILES[profile], ...(source.extra ?? {}) };
  const { data, error } = await db.rpc("register_source_once", { p_key: key, p_row: row });
  const out = (Array.isArray(data) ? data[0] : data) as { r_source_id: string; r_created: boolean; r_status: string } | undefined;
  if (error || !out) throw new Error(`registerSource insert failed: ${error?.message ?? "no row returned"}`);
  if (!out.r_created) await reactivate(out.r_source_id, out.r_status);
  return { source_id: out.r_source_id, created: out.r_created, host };
}

/**
 * Which registry keys the rows without one should take: the oldest row of an institution takes the institution's key, every other row of it takes its page key, and a row whose key is already held (two rows of one page) is
 * reported as a conflict and left unkeyed; code never merges rows. Pure.
 */
function planInstitutionKeys(rows: ReadonlyArray<{ id: string; url: string | null; created_at?: string | null; institution_key?: string | null }>): { assign: Array<{ id: string; key: string }>; conflicts: Array<{ id: string; key: string; heldBy: string }> } {
  const held = new Map<string, string>(rows.filter((r) => r.institution_key).map((r) => [r.institution_key as string, r.id]));
  const assign: Array<{ id: string; key: string }> = [];
  const conflicts: Array<{ id: string; key: string; heldBy: string }> = [];
  const todo = rows.filter((r) => !r.institution_key && r.url).sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id));
  for (const r of todo) {
    const inst = institutionKey(r.url);
    const key = inst && !held.has(inst) ? inst : pageKey(r.url);
    if (!key) continue;
    const owner = held.get(key);
    if (owner) conflicts.push({ id: r.id, key, heldBy: owner });
    else {
      held.set(key, r.id);
      assign.push({ id: r.id, key });
    }
  }
  return { assign, conflicts };
}
/** Key the registry rows that have no institution key yet (planInstitutionKeys), each by a compare-and-set on the empty column. Returns what it did; a failed write is reported, never skipped silently. */
export async function backfillInstitutionKeys(db: Db, rows: ReadonlyArray<{ id: string; url: string | null; created_at?: string | null; institution_key?: string | null }>): Promise<{ keyed: number; conflicts: number; errors: string[] }> {
  const plan = planInstitutionKeys(rows);
  const errors: string[] = [];
  let keyed = 0;
  for (const a of plan.assign) {
    const { error } = await db.from("sources").update({ institution_key: a.key }).eq("id", a.id).is("institution_key", null);
    if (error) errors.push(`${a.id}: ${error.message}`);
    else keyed++;
  }
  return { keyed, conflicts: plan.conflicts.length, errors };
}

export type RegisterAndRateResult =
  | { status: "registered" | "existing"; source_id: string; tier: number; label: string; institution_id: string | null; via: string }
  | { status: "worklist"; host: string; reason: string }
  | { status: "refused"; host: string; reason: string };
/** What a dry call (IMP-042) adds: the tier a host would be registered at, with nothing written. */
export type RegisterAndRateDryResult = RegisterAndRateResult | { status: "would-register"; host: string; tier: number; label: string; via: string };
type RateOpts = { name?: string | null; verdicts?: ReadonlyMap<string, HostVerdictRef> | null };

/**
 * THE registration entry that growth, intake, mint and producers call. The tier is the class table's (a permanent worklist class is refused, an unplaceable host
 * is worklisted, never defaulted); the row is the one of the URL's institution (pickInstitutionRow), never the first row of the host; the institution link is read or created from the registrable domain; the row is read back and its REAL tier returned.
 */
export async function registerAndRate(db: Db, url: string, opts?: RateOpts & { dry?: false }): Promise<RegisterAndRateResult>;
export async function registerAndRate(db: Db, url: string, opts: RateOpts & { dry: boolean }): Promise<RegisterAndRateDryResult>;
export async function registerAndRate(db: Db, url: string, opts: RateOpts & { dry?: boolean } = {}): Promise<RegisterAndRateDryResult> {
  const host = hostOf(url);
  if (!host) return { status: "refused", host: "", reason: "unparseable_url" };
  const never = permanentlyUnregisteredClass(host);
  if (never) return { status: "refused", host, reason: `${never}: the host republishes or hosts another publisher's text and is never registered at any tier` };
  const found = await lookupExactHost(db, url);
  if (!found.ok) throw new Error(`registerAndRate: registry lookup failed for ${url}: ${found.error}`);
  const existing = pickInstitutionRow(found.rows, url);
  const placement = placeHostWithVerdicts(host, [opts.name], opts.verdicts ?? null);
  if (!existing && placement.tier == null) {
    const reason = "the host places in no class-table class and no committed verdict";
    if (!opts.dry) await recordWorklist(db, host, reason, opts.name ?? null);
    return { status: "worklist", host, reason };
  }
  if (opts.dry && !existing) return { status: "would-register", host, tier: placement.tier as number, label: tierLabelOf(placement.tier as number), via: placement.via ?? "class" };
  const reg = existing ? { source_id: existing.id, created: false } : await registerSource(db, { url, name: opts.name ?? null, base_tier: placement.tier as number });
  const real = await readSourceByUrl(db, url);
  const tier = real?.base_tier ?? placement.tier;
  if (tier == null) throw new Error(`registerAndRate: ${reg.source_id} registered but its tier could not be read back`);
  const institution_id = opts.dry ? (real?.institution_id ?? null) : await linkInstitution(db, reg.source_id, host, real?.institution_id ?? null);
  return { status: reg.created ? "registered" : "existing", source_id: reg.source_id, tier, label: tierLabelOf(tier), institution_id, via: existing ? "registry" : (placement.via ?? "class") };
}

/** The one place an unplaced host is kept (host_worklist, migration 0064): every `worklist` answer is recorded here by registerAndRate itself, so no caller can drop it. A failed or absent record is the call's failure, never a silent loss. */
async function recordWorklist(db: Db, host: string, reason: string, name: string | null): Promise<void> {
  const { error } = await db.rpc("record_host_worklist", { p_host: host, p_reason: reason, p_name: name });
  if (error) throw new Error(isMissingObject(error) ? `registerAndRate: host_worklist is absent (migration 0064 is not applied): ${host} cannot be kept for a verdict` : `registerAndRate: recording ${host} on the host worklist failed: ${error.message}`);
}

/** Link a source to its institution (the registrable domain), creating the institution when absent. Every read and write is checked. */
async function linkInstitution(db: Db, sourceId: string, host: string, current: string | null): Promise<string | null> {
  if (current) return current;
  const domain = hostInstitution(host);
  if (!domain) return null;
  const { data: inst, error } = await db.from("institutions").select("id").eq("registrable_domain", domain).maybeSingle();
  if (error) throw new Error(`institution lookup failed for ${domain}: ${error.message}`);
  let id = (inst as { id: string } | null)?.id ?? null;
  if (!id) {
    const ins = await db.from("institutions").insert({ name: host, registrable_domain: domain }).select("id").single();
    if (ins.error || !ins.data) throw new Error(`institution insert failed for ${domain}: ${ins.error?.message ?? "no row"}`);
    id = (ins.data as { id: string }).id;
  }
  const upd = await db.from("sources").update({ institution_id: id }).eq("id", sourceId);
  if (upd.error) throw new Error(`institution link failed for ${sourceId}: ${upd.error.message}`);
  return id;
}
