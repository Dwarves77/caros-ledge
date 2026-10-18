// Ported from old_repo/scripts/lib/db.mjs (lines 601-642)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 1871-1912)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2988-3006)
// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 3341-3361)
// Ported from old_repo/src/lib/sources/source-growth.ts (lines 81-99)
import type { Db } from "@/core/db";
import { fetchAllRows, isMissingObject } from "@/core/db";
import { canonicalUrl, hostOf } from "@/core/shared";

import { classifySourceRole } from "./classify";
import { permanentlyUnregisteredClass, placeHostWithVerdicts, type HostVerdictRef } from "./host-class";
import { hostInstitution, institutionKey } from "./institution";
import { tierLabelOf } from "./tier-contract";

/** How many exact-host rows the duplicate check reads: the first exact-host row is enough, the rest is slack for the in-code re-check. */
const EXACT_HOST_LOOKUP_LIMIT = 25;

/**
 * PostgREST `or` filter selecting registered urls whose host is exactly `hostKey` (lower-case, no www), with or without www, over http or https, as
 * `scheme://host/...` or the bare `scheme://host`. A longer host that merely contains `hostKey` cannot match: after the host comes `/` or the end.
 */
export function exactHostUrlFilter(hostKey: string): string {
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
}
export type ExactHostLookup = { ok: true; rows: RegistryRow[] } | { ok: false; error: string };

/** The registered rows whose host is exactly the URL's host. A read error is returned as a failure, never as "no match" (B-0227). */
export async function lookupExactHost(db: Db, url: string): Promise<ExactHostLookup> {
  const host = hostOf(url);
  if (!host) return { ok: true, rows: [] };
  const { data, error } = await db.from("sources").select("id, url, base_tier, tier_override, status, institution_id").or(exactHostUrlFilter(host)).limit(EXACT_HOST_LOOKUP_LIMIT);
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: ((data ?? []) as RegistryRow[]).filter((r) => hostOf(r.url) === host) };
}

/**
 * The registry row for a URL: the row at the same canonical URL, else the row of the same institution key (registerSource dedups by institution, so a match may
 * sit at a different exact URL). Null when none; a read error throws.
 */
export async function readSourceByUrl(db: Db, url: string): Promise<RegistryRow | null> {
  const found = await lookupExactHost(db, url);
  if (!found.ok) throw new Error(`readSourceByUrl failed for ${url}: ${found.error}`);
  const canon = canonicalUrl(url);
  return found.rows.find((r) => canonicalUrl(r.url) === canon) ?? found.rows.find((r) => institutionKey(r.url) === institutionKey(url)) ?? null;
}

export interface RegisterInput {
  url: string;
  name?: string | null;
  /** A tier from the class table (never a default: no model output and no default value sets base_tier, INV-176). */
  base_tier: number;
  source_role?: string | null;
  institutionKey?: string;
  extra?: Record<string, unknown>;
}
/**
 * Register a source, deduplicated by institution key over every registry row (a paginated read: a capped read made the dedup blind past 1000 rows). An existing
 * row is re-activated when it is not active. A new row is born with its source_role and a base_tier the caller took from the class table.
 */
export async function registerSource(db: Db, source: RegisterInput): Promise<{ source_id: string; created: boolean; host: string }> {
  if (!source?.url) throw new Error("registerSource: source.url required");
  const host = hostOf(source.url);
  if (!host) throw new Error(`registerSource: cannot parse host from ${source.url}`);
  if (!Number.isInteger(source.base_tier) || source.base_tier < 1 || source.base_tier > 7) throw new Error(`registerSource: base_tier ${source.base_tier} is not a tier; a source is never registered at a guessed or defaulted tier`);
  const key = source.institutionKey || institutionKey(source.url);
  const existing = await fetchAllRows<{ id: string; url: string; status: string }>((from, to) => db.from("sources").select("id, url, status").order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 });
  const match = existing.find((s) => institutionKey(s.url) === key);
  if (match) {
    if (match.status !== "active") {
      const { error } = await db.from("sources").update({ status: "active" }).eq("id", match.id);
      if (error) throw new Error(`registerSource: reactivation of ${match.id} failed: ${error.message}`);
    }
    return { source_id: match.id, created: false, host };
  }
  const name = source.name || host;
  const { data, error } = await db
    .from("sources")
    .insert({ url: source.url, name, base_tier: source.base_tier, tier_at_creation: source.base_tier, status: "active", admin_only: false, source_role: source.source_role ?? classifySourceRole(name, source.url), ...(source.extra ?? {}) })
    .select("id")
    .single();
  if (error || !data) throw new Error(`registerSource insert failed: ${error?.message ?? "no row returned"}`);
  return { source_id: (data as { id: string }).id, created: true, host };
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
 * is worklisted, never defaulted); the institution link is read or created from the registrable domain; the row is read back and its REAL tier returned.
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
  const existing = found.rows[0] ?? null;
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
