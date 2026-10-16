// Ported from old_repo/src/lib/sources/institution.ts (lines 1-81)
// Ported from old_repo/scripts/lib/institution-key.mjs (lines 1-30)
import { hostOf } from "@/core/shared";

import portals from "./data/shared-portals.json";

/** Registrable domains that are shared super-domains: the SUBDOMAIN is the institution (documented exceptions, not a public-suffix list). */
const TWO_LEVEL = new Set<string>([
  "co.uk", "gov.uk", "ac.uk", "org.uk", "com.br", "gov.br", "org.br", "co.jp", "go.jp", "or.jp", "ne.jp",
  "gov.cn", "com.cn", "edu.cn", "org.cn", "gov.au", "com.au", "edu.au", "org.au", "gov.in", "co.in", "org.in",
  "nic.in", "gov.sg", "com.sg", "go.kr", "or.kr", "re.kr", "gob.mx", "gov.co", "gob.cl", "gc.ca", "go.id", "gov.za", "gov.hk",
  "europa.eu", "canada.ca", "ca.gov", "ny.gov", "tx.us", "state.tx.us", "wa.gov", "or.us", "ne.gov", "nj.gov",
  "pa.gov", "mass.gov", "oregon.gov", "nc.gov", "ct.gov",
]);

/** The institution key of a host: its registrable domain (eTLD+1) with the super-domain exceptions. */
export function hostInstitution(host: string): string {
  if (!host) return "";
  const h = host.replace(/^www\./, "").toLowerCase();
  const p = h.split(".");
  if (p.length <= 2) return h;
  return TWO_LEVEL.has(p.slice(-2).join(".")) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}

export interface SourceRow {
  id: string;
  url: string;
  base_tier: number | null;
  effective_tier?: number | null;
  tier_override?: number | null;
  /** A 'suspended' source is unselectable by the grounding resolver; an undefined status is included. */
  status?: string | null;
}

/** The grounding tier of a source is base_tier ONLY: reputation (effective_tier) never confers grounding eligibility (INV-175). */
export const tierOfSource = (s: SourceRow | null | undefined): number | null => (s == null ? null : (s.base_tier ?? null));

export interface SpanResolution {
  tier: number | null;
  sourceId: string | null;
}
/** Rows of one institution that carry different base tiers: reported, never settled by row order. */
export interface InstitutionDisagreement {
  institution: string;
  tiers: number[];
  sourceIds: string[];
}
export interface Resolver {
  resolveSpan(resultUrl: string): SpanResolution;
  disagreements: InstitutionDisagreement[];
}

/**
 * The resolver over ALL registry rows (the caller reads them with fetchAllRows). An exact-host tier_override wins;
 * a suspended source populates nothing. The first row of an institution supplies the tier, but every institution whose
 * rows disagree is listed in `disagreements`, so the duplicate-row defect surfaces instead of resolving by order.
 */
export function buildResolver(sources: SourceRow[]): Resolver {
  const instTier = new Map<string, number>();
  const instSourceId = new Map<string, string>();
  const overrideTierByHost = new Map<string, number>();
  const overrideSourceByHost = new Map<string, string>();
  const seen = new Map<string, { tiers: Set<number>; ids: string[] }>();
  for (const s of sources) {
    if (s.status === "suspended") continue;
    const h = hostOf(s.url);
    const k = hostInstitution(h);
    if (!k) continue;
    if (s.tier_override != null) {
      overrideTierByHost.set(h, s.tier_override);
      overrideSourceByHost.set(h, s.id);
    }
    const t = tierOfSource(s);
    if (t == null) continue;
    const group = seen.get(k) ?? { tiers: new Set<number>(), ids: [] };
    group.tiers.add(t);
    group.ids.push(s.id);
    seen.set(k, group);
    if (!instTier.has(k)) {
      instTier.set(k, t);
      instSourceId.set(k, s.id);
    }
  }
  const disagreements = [...seen]
    .filter(([, g]) => g.tiers.size > 1)
    .map(([institution, g]) => ({ institution, tiers: [...g.tiers].sort((a, b) => a - b), sourceIds: g.ids }));
  return {
    disagreements,
    resolveSpan(resultUrl: string): SpanResolution {
      const h = hostOf(resultUrl);
      if (!h) return { tier: null, sourceId: null };
      const override = overrideTierByHost.get(h);
      if (override !== undefined) return { tier: override, sourceId: overrideSourceByHost.get(h) ?? null };
      const k = hostInstitution(h);
      const tier = instTier.get(k);
      return tier !== undefined ? { tier, sourceId: instSourceId.get(k) ?? null } : { tier: null, sourceId: null };
    },
  };
}

/** The registry identity of a URL: the bare host, or host plus a path prefix on a shared government portal (gob.mx/semarnat and gob.mx/economia are two institutions). Empty when unparseable. */
export function institutionKey(url: string | null | undefined): string {
  const host = hostOf(url);
  if (!host) return "";
  const depth = (portals.keyDepth as Record<string, number>)[host];
  if (!depth) return host;
  let path = "";
  try {
    path = new URL(String(url)).pathname;
  } catch {
    path = "";
  }
  const segs = path.split("/").filter(Boolean).slice(0, depth);
  return segs.length ? `${host}/${segs.join("/")}` : host;
}
