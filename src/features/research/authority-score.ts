// Ported from old_repo/scripts/research/authority-score.mjs (lines 1-340)
// Source authority as a distribution of buckets, never a mean (spec 03 section 4): role class (named overrides, then venue and institution type), standings, funding
// independence (three states), reception (velocity under 24 months, never FWCI), integrity. Vendors are never excluded but permanently flagged and capped; an unknown
// role never reads as medium; the absence of a citation footprint never reads as low authority.
import { z } from "zod";

import raw from "./data/authority-rules.json";

const rules = z.object({ roleClasses: z.array(z.string()), namedOverrides: z.array(z.object({ pattern: z.string(), roleClass: z.string() })), institutionTypeToRole: z.record(z.string(), z.string()), highAuthorityRoles: z.array(z.string()), vendorRoles: z.array(z.string()) }).parse(raw);
const ROLE_CLASSES: readonly string[] = rules.roleClasses;
const OVERRIDES = rules.namedOverrides.map((o) => ({ re: new RegExp(o.pattern, "i"), roleClass: o.roleClass }));
const AVG_MONTH_MS = 30.44 * 86_400_000;

type Rec = Record<string, unknown>;
export type Bucket = "highAuthorityIndependent" | "medium" | "vendorFlagged" | "unknown";
export interface ScoredSource {
  sourceId: string;
  method: string;
  roleClass: string;
  institutionalStanding: Rec | null;
  authorStanding: Rec | null;
  fundingIndependence: "independent" | "dependent" | "unknown";
  reception: { metric: string; value: number | null; method: string };
  integrity: { isRetracted: boolean; hasCorrections: boolean; predatoryVenue: boolean | "unknown" };
  bucket: Bucket;
  greyLiterature?: Rec;
}

function classifyRoleClass(record: Rec | null | undefined): string {
  if (!record) return "unknown";
  if (typeof record.roleClass === "string" && ROLE_CLASSES.includes(record.roleClass)) return record.roleClass;
  const hit = OVERRIDES.find((o) => o.re.test(String(record.displayName ?? "")));
  if (hit) return hit.roleClass;
  if (record.venueType === "journal") return "journal";
  if (record.venueType === "press" || record.venueType === "analytical_press") return "analytical_press";
  return (record.type ? rules.institutionTypeToRole[String(record.type).toLowerCase()] : undefined) ?? "unknown";
}

function computeInstitutionalStanding(s: Rec | null | undefined): Rec | null {
  if (!s || (typeof s.inTopicFwci !== "number" && typeof s.inTopicWorksCount !== "number")) return null;
  return { inTopicFwci: typeof s.inTopicFwci === "number" ? s.inTopicFwci : null, inTopicWorksCount: typeof s.inTopicWorksCount === "number" ? s.inTopicWorksCount : 0, topicShare: typeof s.topicShare === "number" ? s.topicShare : null };
}
function computeAuthorStanding(author: Rec | null | undefined, now: Date = new Date()): Rec | null {
  if (!author) return null;
  const summary = (author.summary_stats ?? {}) as Rec;
  const byYear = Array.isArray(author.counts_by_year) ? (author.counts_by_year as Rec[]) : [];
  const year = now.getUTCFullYear();
  const recent = byYear.filter((r) => typeof r?.year === "number" && r.year >= year - 1).reduce((s, r) => s + (typeof r.works_count === "number" ? r.works_count : 0), 0);
  return {
    inTopicWorksCount: typeof author.inTopicWorksCount === "number" ? author.inTopicWorksCount : typeof author.works_count === "number" ? author.works_count : null,
    inTopicFwci: typeof author.inTopicFwci === "number" ? author.inTopicFwci : typeof summary.fwci === "number" ? summary.fwci : null,
    hIndex: typeof summary.h_index === "number" ? summary.h_index : null,
    recentWorksCount: byYear.length ? recent : null,
  };
}
/** independent only when funding is disclosed AND its funder is not a commercial beneficiary; dependent when it is; otherwise unknown (never assumed independent). */
const computeFundingIndependence = (f: Rec | null | undefined): "independent" | "dependent" | "unknown" => (!f || f.disclosed !== true ? "unknown" : f.funderIsCommercialBeneficiary === true ? "dependent" : f.funderIsCommercialBeneficiary === false ? "independent" : "unknown");

/** Reception: under 24 months a per-month citation velocity (FWCI is suppressed, and the velocity is never presented as FWCI); otherwise the percentile, then FWCI, else unknown. */
function computeReception(work: Rec | null | undefined, now: Date): ScoredSource["reception"] {
  if (!work) return { metric: "unknown", value: null, method: "no work record resolved for this source" };
  const pub = work.publicationDate ? new Date(String(work.publicationDate)) : null;
  const ageMonths = pub && !Number.isNaN(pub.getTime()) ? (now.getTime() - pub.getTime()) / AVG_MONTH_MS : null;
  if (ageMonths !== null && ageMonths < 24) {
    if (typeof work.citedByCount === "number" && ageMonths > 0) return { metric: "velocity", value: work.citedByCount / ageMonths, method: "citations-per-month since publication; FWCI suppressed under 24 months (spec 03 section 4). A raw per-month rate, not a cohort-relative percentile: never presented as FWCI." };
    return { metric: "unknown", value: null, method: "work is under 24 months old and carries no citation count to derive a velocity rate from" };
  }
  if (typeof work.citationNormalizedPercentile === "number") return { metric: "citation_normalized_percentile", value: work.citationNormalizedPercentile, method: "OpenAlex citation_normalized_percentile" };
  if (typeof work.fwci === "number") return { metric: "fwci", value: work.fwci, method: "OpenAlex fwci (field-weighted citation impact)" };
  return { metric: "unknown", value: null, method: "no fwci or citation_normalized_percentile on record" };
}
const computeIntegrity = (work: Rec | null | undefined): ScoredSource["integrity"] => ({ isRetracted: work?.isRetracted === true, hasCorrections: work?.hasCorrections === true, predatoryVenue: typeof work?.predatoryVenue === "boolean" ? work.predatoryVenue : "unknown" });

/** Vendors and industry associations are capped at vendorFlagged; an unknown role is unknown (never medium); highAuthorityIndependent needs a high-authority role, independent funding and no retraction. */
function bucketForSource(p: { roleClass: string; fundingIndependence: string; integrity: { isRetracted: boolean } }): Bucket {
  if (rules.vendorRoles.includes(p.roleClass)) return "vendorFlagged";
  if (p.roleClass === "unknown") return "unknown";
  return rules.highAuthorityRoles.includes(p.roleClass) && p.fundingIndependence === "independent" && !p.integrity.isRetracted ? "highAuthorityIndependent" : "medium";
}

function scoreOpenAlexSource(record: Rec, opts: { now?: Date } = {}): ScoredSource {
  const now = opts.now ?? new Date();
  const roleClass = classifyRoleClass((record.institution ?? {}) as Rec);
  const fundingIndependence = computeFundingIndependence((record.funding ?? null) as Rec | null);
  const integrity = computeIntegrity((record.work ?? null) as Rec | null);
  return { sourceId: String(record.sourceId), method: "openalex", roleClass, institutionalStanding: computeInstitutionalStanding((record.institution ?? null) as Rec | null), authorStanding: computeAuthorStanding((record.author ?? null) as Rec | null, now), fundingIndependence, reception: computeReception((record.work ?? null) as Rec | null, now), integrity, bucket: bucketForSource({ roleClass, fundingIndependence, integrity }) };
}
function scoreGreyLiteratureSource(record: Rec): ScoredSource {
  const roleClass = classifyRoleClass({ displayName: record.displayName, roleClass: record.roleClass });
  const fundingIndependence = computeFundingIndependence((record.funding ?? null) as Rec | null);
  const integrity = { isRetracted: record.integrityConcern === true, hasCorrections: false, predatoryVenue: "unknown" as const };
  const tri = (v: unknown) => (typeof v === "boolean" ? v : "unknown");
  return {
    sourceId: String(record.sourceId), method: "grey_literature_non_citation", roleClass, institutionalStanding: null, authorStanding: null, fundingIndependence,
    reception: { metric: "unknown", value: null, method: "grey-literature source: no citation footprint exists to measure (spec 03 section 4: absence of a citation footprint is a coverage artefact, never low authority). Authority is read from institutional mandate, method transparency, independent replication and citation by indexed literature instead." },
    integrity, bucket: bucketForSource({ roleClass, fundingIndependence, integrity }),
    greyLiterature: { institutionalMandate: record.institutionalMandate === true, methodTransparent: tri(record.methodTransparent), independentlyReplicated: tri(record.independentlyReplicated), citedByIndexedLiterature: tri(record.citedByIndexedLiterature) },
  };
}
export function scoreSource(record: Rec, opts: { now?: Date } = {}): ScoredSource {
  if (!record || !record.sourceId) throw new Error("authority-score: scoreSource requires a record with a sourceId");
  if (record.kind === "grey_literature") return scoreGreyLiteratureSource(record);
  if (record.kind === "openalex") return scoreOpenAlexSource(record, opts);
  throw new Error(`authority-score: unknown record.kind "${record.kind}" (expected "openalex" or "grey_literature")`);
}
const authorityScore = scoreSource;

export function aggregateAuthorityDistribution(sources: readonly ScoredSource[] | null | undefined) {
  const list = sources ?? [];
  const dist = { highAuthorityIndependent: 0, medium: 0, vendorFlagged: 0, unknown: 0, integrityFlagged: 0, sources: list };
  for (const s of list) {
    dist[s.bucket] += 1;
    if (s.integrity.isRetracted) dist.integrityFlagged += 1;
  }
  return dist;
}
