// Ported from old_repo/src/lib/classification/classify-source.mjs (lines 1-82)
// Ported from old_repo/src/lib/classification/jurisdiction.mjs (lines 1-65)
// Ported from old_repo/src/lib/classification/scope.mjs (lines 1-156)
// Ported from old_repo/src/lib/classification/expected-output.mjs (lines 1-61)
// Ported from old_repo/src/lib/classification/vocab.mjs (lines 1-87)
// Ported from old_repo/src/lib/classification/routing.mjs (lines 64-100)
import { hostOf } from "@/core/shared";

const KNOWN_FREE_TEXT_JURISDICTIONS = ["EU", "GLOBAL", "IMO", "ICAO"] as const;
const SCOPE_TOPICS = ["regulatory", "finance", "technology", "fuel", "labor", "infrastructure", "environmental", "social", "governance", "transport", "packaging", "customs", "conservation", "materials_science"] as const;
/** The leg modes of the transport vocabulary (the contracts slice owns the canonical list; `multimodal` is corridor-only and excluded). */
const LEG_MODES = ["road", "rail", "ocean", "inland_waterway", "air"] as const;

const SCOPE_VERTICALS = ["fine_art", "live_events", "luxury", "film_tv", "automotive", "humanitarian", "freight_general", "all", "none"] as const;
const SURFACES = ["regulations", "market", "operations", "research"] as const;
const AXIS5_OUT_OF_SCOPE = "out_of_scope";
const AXIS5_CATEGORIES: readonly string[] = [...SURFACES, AXIS5_OUT_OF_SCOPE];
/** The only sources columns the classify-sources job ever writes. */
type ApplicableField = "jurisdiction_iso" | "scope_topics" | "scope_modes" | "scope_verticals" | "expected_output";

/** Shape, not membership: a supranational sentinel, an ISO 3166-1 alpha-2 country code or a 3166-2 subdivision. */
export const isValidJurisdictionValue = (value: unknown): boolean => {
  const v = String(value ?? "");
  return (KNOWN_FREE_TEXT_JURISDICTIONS as readonly string[]).includes(v) || /^[A-Z]{2}$/.test(v) || /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(v);
};

interface Classified<T> {
  value: T;
  confidence: "high" | "medium";
  basis: string;
}
const matchAny = (text: string, patterns: readonly RegExp[]) => patterns.some((re) => re.test(text));

// Axis 3: host-suffix to jurisdiction. Each entry is a high-confidence institutional-domain signal, anchored (^|.) so a bare gov domain matches too.
const GOV_HOST_JURISDICTION: ReadonlyArray<[RegExp, string]> = [
  [/(^|\.)europa\.eu$/, "EU"], [/(^|\.)gov\.uk$/, "GB"], [/(^|\.)parliament\.uk$/, "GB"], [/(^|\.)gouv\.fr$/, "FR"], [/(^|\.)bund\.de$/, "DE"], [/(^|\.)bundestag\.de$/, "DE"],
  [/(^|\.)gob\.mx$/, "MX"], [/(^|\.)gob\.es$/, "ES"], [/(^|\.)gc\.ca$/, "CA"], [/(^|\.)gov\.au$/, "AU"], [/(^|\.)govt\.nz$/, "NZ"], [/(^|\.)go\.jp$/, "JP"],
  [/(^|\.)gov\.sg$/, "SG"], [/(^|\.)gov\.hk$/, "HK"], [/(^|\.)gov\.in$/, "IN"], [/(^|\.)gov\.cn$/, "CN"], [/(^|\.)gov\.za$/, "ZA"], [/(^|\.)gov\.br$/, "BR"], [/(^|\.)gov\.ie$/, "IE"], [/\.gov$/, "US"],
];
function classifySourceJurisdiction({ url, sourceRole }: { url?: string | null | undefined; sourceRole?: string | null | undefined }): Classified<string> | null {
  const host = hostOf(url);
  if (!host) return null;
  if (sourceRole === "intergovernmental_body" || /\.int$/.test(host)) return { value: "GLOBAL", confidence: "high", basis: sourceRole === "intergovernmental_body" ? "source_role=intergovernmental_body" : "host is a .int treaty-organization domain" };
  for (const [re, value] of GOV_HOST_JURISDICTION) if (re.test(host) && isValidJurisdictionValue(value)) return { value, confidence: "high", basis: `host ${host} matches ${re}` };
  return null;
}

// Axis 4b: transport-mode scope.
const MODE_KEYWORDS: Record<string, RegExp[]> = {
  air: [/\bair\s*(cargo|freight)\b/i, /\baviation\b/i, /\bairline/i, /\bicao\b/i],
  ocean: [/\bocean\b/i, /\bmaritime\b/i, /\bshipping\b/i, /\bvessel/i, /\bport\b/i, /\bimo\b/i, /\bbunkering\b/i],
  road: [/\broad\s*(freight|transport)\b/i, /\btrucking\b/i, /\bhaulage\b/i, /\bhgv\b/i, /\bhighway\b/i],
  rail: [/\brail\s*(freight|transport)?\b/i, /\brailway/i, /\btrain\b/i],
};
const NO_TRANSPORT_ROLES = new Set(["standards_body", "statistical_data_agency"]);
function classifyScopeModes({ name, sourceRole }: { name?: string | null | undefined; sourceRole?: string | null | undefined }): Classified<string[]> | null {
  const n = String(name || "");
  const matched = LEG_MODES.filter((m) => matchAny(n, MODE_KEYWORDS[m] ?? []));
  if (matched.length > 0) return { value: [...matched], confidence: matched.length === 1 ? "high" : "medium", basis: `name matches mode keyword(s) for ${matched.join(", ")}` };
  if (sourceRole === "intergovernmental_body" && /\btransport|freight|logistics\b/i.test(n)) return { value: ["all"], confidence: "medium", basis: "intergovernmental body with a general transport remit" };
  if (sourceRole && NO_TRANSPORT_ROLES.has(sourceRole)) return { value: ["none"], confidence: "medium", basis: `role=${sourceRole} does not address transport (Axis 4b)` };
  return null;
}

// Axis 4c: vertical scope.
const VERTICAL_KEYWORDS: Record<string, RegExp[]> = {
  fine_art: [/\bfine\s*art\b/i, /\bgallery\b/i, /\bmuseum\b/i, /\bart\s*handl/i, /\bicom\b/i, /\bgallery climate coalition\b/i, /\bantiques?\b/i, /\bheritage conservation\b/i],
  live_events: [/\blive\s*events?\b/i, /\ba greener future\b/i, /\btouring\b/i, /\bfestival\b/i, /\bconcert\s*production\b/i, /\bexhibition\s*production\b/i],
  luxury: [/\bluxury\b/i, /\bhaute\s*couture\b/i, /\bfashion\s*house\b/i],
  film_tv: [/\bfilm\b/i, /\btelevision\b/i, /\balbert\b/i, /\bbafta\b/i, /\bbroadcast(er)?\b/i, /\bstreaming\s*production\b/i],
  automotive: [/\bautomotive\b/i, /\bvehicle\s*manufactur/i, /\boem\b/i],
  humanitarian: [/\bhumanitarian\b/i, /\bunhrd\b/i, /\bdisaster\s*relief\b/i, /\brefugee\s*logistics\b/i],
};
const CROSS_VERTICAL_ROLES = new Set(["standards_body", "intergovernmental_body"]);
const FREIGHT_GENERAL_ROLES = new Set(["primary_legal_authority", "trade_press", "industry_association", "industry_data_provider", "vendor_corporate", "statistical_data_agency", "government_press"]);
function classifyScopeVerticals({ name, sourceRole }: { name?: string | null | undefined; sourceRole?: string | null | undefined }): Classified<string[]> | null {
  const n = String(name || "");
  const matched = SCOPE_VERTICALS.filter((v) => matchAny(n, VERTICAL_KEYWORDS[v] ?? []));
  if (matched.length > 0) return { value: [...matched], confidence: "high", basis: `name matches vertical keyword(s) for ${matched.join(", ")}` };
  if (sourceRole && CROSS_VERTICAL_ROLES.has(sourceRole)) return { value: ["all"], confidence: "medium", basis: `role=${sourceRole}: standards and frameworks apply across verticals` };
  if (sourceRole && FREIGHT_GENERAL_ROLES.has(sourceRole)) return { value: ["freight_general"], confidence: "medium", basis: `role=${sourceRole}: general freight coverage without vertical specificity` };
  return null;
}

// Axis 4a: topic scope. A keyword match is "medium" by design: regular and material coverage needs a live, re-checkable signal.
const TOPIC_KEYWORDS: Record<string, RegExp[]> = {
  regulatory: [/\bregulat/i, /\blegislat/i, /\bdirective\b/i, /\bstatute\b/i],
  finance: [/\bfinance\b/i, /\bfinancial\b/i, /\binvestor/i, /\bcapital markets\b/i],
  technology: [/\btechnolog/i, /\binnovation\b/i, /\bdigital\b/i],
  fuel: [/\bfuel\b/i, /\bbunker/i, /\bhydrogen\b/i, /\bsaf\b/i, /\belectrofuel/i],
  labor: [/\blabor\b/i, /\blabour\b/i, /\bworkforce\b/i, /\bemployment\b/i],
  infrastructure: [/\binfrastructure\b/i, /\bport(s)?\s*authority\b/i, /\bcharging\s*infrastructure\b/i],
  environmental: [/\benvironment/i, /\bclimate\b/i, /\becolog/i, /\bemissions?\b/i],
  social: [/\bsocial\b/i, /\bhuman\s*rights\b/i, /\blabou?r\s*rights\b/i],
  governance: [/\bgovernance\b/i, /\bcorporate\s*governance\b/i],
  transport: [/\btransport/i, /\bfreight\b/i, /\blogistics\b/i, /\bshipping\b/i],
  packaging: [/\bpackaging\b/i],
  customs: [/\bcustoms\b/i, /\btariff/i, /\btrade\s*compliance\b/i],
  conservation: [/\bconservation\b/i, /\bheritage\b/i],
  materials_science: [/\bmaterials?\s*science\b/i, /\bmaterials?\s*research\b/i],
};
export const REGULATORY_TOPIC_ROLES = new Set(["primary_legal_authority", "government_press"]);
/** The literal matched substring (the evidence) for one topic against the source's own name, or null; re-derived at decision time, never trusted from a stale payload. */
export function topicKeywordMatch(topic: string, name: string | null | undefined): string | null {
  for (const re of TOPIC_KEYWORDS[topic] ?? []) {
    const m = String(name || "").match(re);
    if (m) return m[0];
  }
  return null;
}
function classifyScopeTopics({ name, sourceRole }: { name?: string | null | undefined; sourceRole?: string | null | undefined }): Classified<string[]> | null {
  const matched = new Set<string>(SCOPE_TOPICS.filter((t) => matchAny(String(name || ""), TOPIC_KEYWORDS[t] ?? [])));
  if (sourceRole && REGULATORY_TOPIC_ROLES.has(sourceRole)) matched.add("regulatory");
  if (matched.size === 0) return null;
  return { value: [...matched], confidence: "medium", basis: 'name/role keyword match; "regular and material coverage" (Axis 4a) needs a re-checkable signal' };
}

// Axis 5: the framework's default expected-output distribution per role (range midpoints), normalised.
const RAW_BY_ROLE: Record<string, Record<string, number> | null> = {
  primary_legal_authority: { regulations: 60, research: 25, market: 5, operations: 5, out_of_scope: 5 },
  intergovernmental_body: { regulations: 5, research: 55, market: 25, operations: 15, out_of_scope: 5 },
  standards_body: { regulations: 25, research: 65, market: 5, operations: 0, out_of_scope: 7.5 },
  academic_research: { regulations: 0, research: 85, market: 7.5, operations: 0, out_of_scope: 5 },
  statistical_data_agency: { regulations: 0, research: 5, market: 25, operations: 75, out_of_scope: 5 },
  industry_data_provider: { regulations: 0, research: 7.5, market: 85, operations: 5, out_of_scope: 5 },
  trade_press: { regulations: 25, research: 7.5, market: 65, operations: 0, out_of_scope: 10 },
  industry_association: { regulations: 0, research: 25, market: 55, operations: 15, out_of_scope: 5 },
  vendor_corporate: { regulations: 0, research: 0, market: 85, operations: 0, out_of_scope: 10 },
  government_press: null,
};
function normalizeDistribution(raw: Record<string, number> | null | undefined): Record<string, number> {
  const total = AXIS5_CATEGORIES.reduce((s, c) => s + (raw?.[c] ?? 0), 0);
  return Object.fromEntries(AXIS5_CATEGORIES.map((c) => [c, total > 0 ? (raw?.[c] ?? 0) / total : 0]));
}
/** The default Axis-5 distribution for a role, or null for an unknown role and for government_press ("varies": never guessed). */
function expectedOutputForRole(role: string | null | undefined): Record<string, number> | null {
  const raw = role ? RAW_BY_ROLE[role] : undefined;
  return raw ? normalizeDistribution(raw) : null;
}
export function isValidDistribution(dist: unknown): boolean {
  if (!dist || typeof dist !== "object") return false;
  const d = dist as Record<string, unknown>;
  const keys = Object.keys(d).sort();
  if (keys.join() !== [...AXIS5_CATEGORIES].sort().join()) return false;
  let sum = 0;
  for (const c of AXIS5_CATEGORIES) {
    const v = d[c];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return false;
    sum += v;
  }
  return Math.abs(sum - 1) < 1e-9;
}
/** Framework 5b: observed deviates from expected by more than `thresholdPoints` on any category. */
export function detectDrift(observed: Record<string, number> | null, expected: Record<string, number> | null, thresholdPoints = 30): { drifted: boolean; deltas: Record<string, number> } {
  const deltas: Record<string, number> = {};
  if (!observed || !expected) return { drifted: false, deltas };
  let drifted = false;
  for (const c of AXIS5_CATEGORIES) {
    const d = Math.abs((observed[c] ?? 0) - (expected[c] ?? 0)) * 100;
    deltas[c] = d;
    if (d > thresholdPoints) drifted = true;
  }
  return { drifted, deltas };
}
/** The observed distribution of a source's own items through an injected item-to-surface classifier ("uncategorized" is out_of_scope); null when there are none. */
export function observedDistributionFromItems(items: ReadonlyArray<{ item_type?: string | null; domain?: number | null }>, surfaceOf: (itemType: string | null, domain: number | null) => string): Record<string, number> | null {
  const counts: Record<string, number> = Object.fromEntries(AXIS5_CATEGORIES.map((c) => [c, 0]));
  for (const it of items) {
    const surface = surfaceOf(it.item_type ?? null, typeof it.domain === "number" ? it.domain : null);
    const bucket = surface === "uncategorized" ? AXIS5_OUT_OF_SCOPE : surface;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  if (items.length === 0) return null;
  return Object.fromEntries(AXIS5_CATEGORIES.map((c) => [c, (counts[c] ?? 0) / items.length]));
}

export interface AxisSource {
  id?: string | null;
  name?: string | null;
  url?: string | null;
  source_role?: string | null;
  jurisdiction_iso?: unknown;
  scope_topics?: unknown;
  scope_modes?: unknown;
  scope_verticals?: unknown;
  expected_output?: unknown;
}
export interface AxisProposal {
  field: ApplicableField;
  value: unknown;
  confidence: "high" | "medium";
  basis: string;
}
const isEmptyArray = (v: unknown) => !Array.isArray(v) || v.length === 0;

/** Every derivable Axis 3/4/5 proposal for one source's currently-empty fields. A gap with no derivable value contributes nothing (never guessed). */
export function classifySourceAxes(source: AxisSource): { sourceId: string | null; hasGap: boolean; proposals: AxisProposal[] } {
  const gaps = { jurisdiction_iso: isEmptyArray(source.jurisdiction_iso), scope_topics: isEmptyArray(source.scope_topics), scope_modes: isEmptyArray(source.scope_modes), scope_verticals: isEmptyArray(source.scope_verticals), expected_output: source.expected_output == null };
  const sourceRole = source.source_role ?? null;
  const proposals: AxisProposal[] = [];
  if (gaps.jurisdiction_iso) {
    const j = classifySourceJurisdiction({ url: source.url, sourceRole });
    if (j) proposals.push({ field: "jurisdiction_iso", value: [j.value], confidence: j.confidence, basis: j.basis });
  }
  for (const [field, run] of [["scope_topics", classifyScopeTopics], ["scope_modes", classifyScopeModes], ["scope_verticals", classifyScopeVerticals]] as const) {
    if (!gaps[field]) continue;
    const c = run({ name: source.name, sourceRole });
    if (c) proposals.push({ field, value: c.value, confidence: c.confidence, basis: c.basis });
  }
  if (gaps.expected_output && sourceRole) {
    const eo = expectedOutputForRole(sourceRole);
    if (eo) proposals.push({ field: "expected_output", value: eo, confidence: "medium", basis: `framework default Axis-5 distribution for source_role=${sourceRole}` });
  }
  return { sourceId: source.id ?? null, hasGap: Object.values(gaps).some(Boolean), proposals };
}
