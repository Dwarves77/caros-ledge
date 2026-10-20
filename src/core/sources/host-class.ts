// Ported from old_repo/src/lib/sources/host-authority.ts (lines 76-108)
// Ported from old_repo/src/lib/sources/host-authority.ts (lines 216-228)
// Ported from old_repo/src/lib/sources/host-authority.ts (lines 245-263)
// Ported from old_repo/src/lib/sources/host-authority.ts (lines 341-426)
// Ported from old_repo/src/lib/sources/host-authority.ts (lines 435-535)
// Ported from old_repo/src/lib/sources/host-authority.ts (lines 578-659)
import { z } from "zod";

import { hostOf } from "@/core/shared";

import raw from "./data/host-class.json";
import { HOST_CLASS_TIER, isKnownHostClass } from "./tier-contract";

const rx = z.string().transform((s) => new RegExp(s));
const words = z.array(z.string());
const schema = z.object({
  legalPrimary: rx,
  legalPublisherAllow: words,
  govIntergov: rx,
  intergovAnalysis: rx,
  govLabels: words,
  govFullDomains: words,
  verifierCab: rx,
  academicTld: rx,
  associationAllow: words,
  standardsBodyAllow: words,
  lawfirm: rx,
  news: rx,
  analysis: rx,
  big4Advisory: rx,
  doiResolver: rx,
  legalAggregator: rx,
  hostingPlatform: rx,
  ruledHosts: z.record(z.string(), z.number().int().min(1).max(7)),
  residue: z.object({ legalWords: words, academicWords: words, associationWords: words, govHostLabels: words, genericTldExclude: words, govNounWords: words, thinkTankWords: words, newsWords: words, pressroomWords: words, analysisWords: words }),
});
const D = schema.parse(raw);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LEGAL_PUBLISHERS = new Set(D.legalPublisherAllow);
const ASSOCIATIONS = new Set(D.associationAllow);
const STANDARDS_BODIES = new Set(D.standardsBodyAllow);
const RULED = new Map(Object.entries(D.ruledHosts));
const GOV_LABEL_UNDER_CC_TLD = new RegExp(`(^|\\.)(${D.govLabels.join("|")})\\.[a-z]{2}$`);
const GOV_TLD = new RegExp(`(^|\\.)gov$|${GOV_LABEL_UNDER_CC_TLD.source}|(^|\\.)(${D.govFullDomains.map(esc).join("|")})$`);
const RESIDUE_GOV_LABEL = new RegExp(`(^|\\.)(${D.residue.govHostLabels.join("|")})\\.([a-z]+)$`);
const GENERIC_TLD = new Set(D.residue.genericTldExclude);
const LEGAL_AGGREGATOR = new RegExp(`${D.doiResolver.source}|${D.legalAggregator.source}`);
const UNIVERSITY_PREFIX = /(?:^|[^a-z0-9])universit/;

const norm = (host: string | null | undefined): string => hostOf(host).replace(/\.$/, "");

/** The tier a host's own class names: legal 1, gov 2, intergovernmental analysis 3, or null (never a guess, never a default). */
function codifiedTierForHost(host: string | null | undefined): number | null {
  const h = norm(host);
  if (!h) return null;
  if (D.legalPrimary.test(h) || LEGAL_PUBLISHERS.has(h)) return HOST_CLASS_TIER.legal ?? null;
  if (D.intergovAnalysis.test(h)) return HOST_CLASS_TIER.intergov_analysis ?? null;
  if (D.govIntergov.test(h) || GOV_TLD.test(h)) return HOST_CLASS_TIER.gov ?? null;
  return null;
}

export function isDoiResolverHost(host: string | null | undefined): boolean {
  return D.doiResolver.test(norm(host));
}

/** A republisher or a hosting platform is never the publisher: it is never registered at any tier. */
export type PermanentWorklistClass = "aggregator" | "platform";
export function permanentlyUnregisteredClass(host: string | null | undefined): PermanentWorklistClass | null {
  const h = norm(host);
  if (!h) return null;
  if (LEGAL_AGGREGATOR.test(h)) return "aggregator";
  if (D.hostingPlatform.test(h)) return "platform";
  return null;
}

const normalizeName = (name: string | null | undefined): string =>
  String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const hasWord = (text: string, phrase: string): boolean => new RegExp(`(?:^|[^a-z0-9])${esc(phrase)}(?:[^a-z0-9]|$)`).test(text);
const hasAny = (text: string, list: readonly string[]): boolean => list.some((p) => hasWord(text, p));

function governmentTier(host: string, name: string): number | null {
  if (hasAny(name, D.residue.thinkTankWords)) return null;
  const m = RESIDUE_GOV_LABEL.exec(host);
  if (m != null && !GENERIC_TLD.has(m[3] ?? "")) return HOST_CLASS_TIER.gov ?? null;
  return hasAny(name, D.residue.govNounWords) ? (HOST_CLASS_TIER.gov ?? null) : null;
}
function associationTier(name: string, host: string): number | null {
  if (hasAny(name, D.residue.associationWords)) return HOST_CLASS_TIER.association ?? null;
  if (hasWord(name, "council") && !hasAny(name, D.residue.thinkTankWords) && governmentTier(host, name) == null) return HOST_CLASS_TIER.association ?? null;
  return null;
}
function newsTier(host: string, name: string): number | null {
  if (hasAny(name, D.residue.pressroomWords)) return null;
  return hasAny(name, D.residue.newsWords) || /\.news$/.test(host) ? (HOST_CLASS_TIER.news ?? null) : null;
}

export type ResidueRuleId = "legal" | "academic" | "association" | "government" | "news" | "analysis" | "company" | "worklist";
export interface ResidueClassification {
  tier: number | null;
  rule: ResidueRuleId;
}
/** The eight residue rules over the stored registry name plus the host, in their fixed precedence. */
function classifyResidueRuling(host: string | null | undefined, name?: string | null): ResidueClassification {
  const h = norm(host);
  const n = normalizeName(name);
  if (h) {
    if (hasAny(n, D.residue.legalWords)) return { tier: HOST_CLASS_TIER.legal ?? null, rule: "legal" };
    if (hasAny(n, D.residue.academicWords) || UNIVERSITY_PREFIX.test(n)) return { tier: HOST_CLASS_TIER.academic ?? null, rule: "academic" };
    const association = associationTier(n, h);
    if (association != null) return { tier: association, rule: "association" };
    const government = governmentTier(h, n);
    if (government != null) return { tier: government, rule: "government" };
    const news = newsTier(h, n);
    if (news != null) return { tier: news, rule: "news" };
    if (hasAny(n, D.residue.analysisWords)) return { tier: HOST_CLASS_TIER.analysis ?? null, rule: "analysis" };
  }
  if (name != null && String(name).trim() !== "") return { tier: HOST_CLASS_TIER.company ?? null, rule: "company" };
  return { tier: null, rule: "worklist" };
}

/** Every host-only check (it never reads a name), in precedence; null means the residue ruling over the name(s) decides next. */
function hostOnlyTier(host: string | null | undefined): number | null {
  const codified = codifiedTierForHost(host);
  if (codified != null) return codified;
  const h = norm(host);
  if (!h) return null;
  const ruled = RULED.get(h);
  if (ruled != null) return ruled;
  if (D.verifierCab.test(h)) return HOST_CLASS_TIER.verifier ?? null;
  if (D.academicTld.test(h)) return HOST_CLASS_TIER.academic ?? null;
  if (ASSOCIATIONS.has(h)) return HOST_CLASS_TIER.association ?? null;
  if (STANDARDS_BODIES.has(h)) return HOST_CLASS_TIER.standards_body ?? null;
  if (D.analysis.test(h) || D.big4Advisory.test(h)) return HOST_CLASS_TIER.analysis ?? null;
  if (D.lawfirm.test(h) || D.news.test(h)) return HOST_CLASS_TIER.lawfirm ?? null;
  return null;
}

/** The register-at-grounding class tier of a host (with one optional name), or null for the worklist. Deterministic: no guess, no default. */
export function classTierForHost(host: string | null | undefined, name?: string | null): number | null {
  if (permanentlyUnregisteredClass(host) != null) return null;
  const pre = hostOnlyTier(host);
  if (pre != null) return pre;
  const h = norm(host);
  return h ? classifyResidueRuling(h, name).tier : null;
}

const RESIDUE_PRECEDENCE: Readonly<Record<ResidueRuleId, number>> = { legal: 1, academic: 2, association: 3, government: 4, news: 5, analysis: 6, company: 7, worklist: 8 };

/** The class tier over every stored name of one host: the most authoritative rule any name satisfies, never the first row's name alone. */
function classTierForHostAcrossNames(host: string | null | undefined, names?: ReadonlyArray<string | null | undefined> | null): number | null {
  if (permanentlyUnregisteredClass(host) != null) return null;
  const pre = hostOnlyTier(host);
  if (pre != null) return pre;
  const h = norm(host);
  if (!h) return null;
  let bestTier: number | null = null;
  let bestRank = Infinity;
  for (const name of names && names.length ? names : [undefined]) {
    const { tier, rule } = classifyResidueRuling(h, name);
    if (RESIDUE_PRECEDENCE[rule] < bestRank) {
      bestRank = RESIDUE_PRECEDENCE[rule];
      bestTier = tier;
    }
  }
  return bestTier;
}

export interface HostVerdictRef {
  class: string;
  batch?: string;
}
export interface VerdictPlacement {
  tier: number;
  class: string;
  batch: string | null;
}
/** A committed host verdict names a CLASS from the table; the tier is read from the table, so a verdict mints no tier the table lacks. */
function verdictPlacementForHost(host: string | null | undefined, verdicts: ReadonlyMap<string, HostVerdictRef> | null | undefined): VerdictPlacement | null {
  if (!verdicts || verdicts.size === 0) return null;
  const h = norm(host);
  if (!h || permanentlyUnregisteredClass(h) != null) return null;
  const v = verdicts.get(h);
  const tier = v && isKnownHostClass(v.class) ? HOST_CLASS_TIER[v.class] : undefined;
  return v && tier !== undefined ? { tier, class: v.class, batch: v.batch ?? null } : null;
}

export interface HostPlacement {
  tier: number | null;
  via: "class" | "verdict" | "residue" | null;
  verdict: VerdictPlacement | null;
}
/** Never-register classes, then the host-only rules, then a committed verdict, then the residue ruling over the name(s). */
export function placeHostWithVerdicts(host: string | null | undefined, names: ReadonlyArray<string | null | undefined> | null | undefined, verdicts: ReadonlyMap<string, HostVerdictRef> | null | undefined): HostPlacement {
  if (permanentlyUnregisteredClass(host) != null) return { tier: null, via: null, verdict: null };
  const hostOnly = hostOnlyTier(host);
  if (hostOnly != null) return { tier: hostOnly, via: "class", verdict: null };
  const verdict = verdictPlacementForHost(host, verdicts);
  if (verdict != null) return { tier: verdict.tier, via: "verdict", verdict };
  const residue = classTierForHostAcrossNames(host, names);
  return residue != null ? { tier: residue, via: "residue", verdict: null } : { tier: null, via: null, verdict: null };
}

export interface PoolHostDecision {
  action: "inherit" | "register" | "worklist";
  /** The deterministic tier to register or inherit at; null for the worklist (never a guessed tier). */
  tier: number | null;
}

