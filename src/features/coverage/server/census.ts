// Ported from old_repo/src/lib/coverage/index-data.ts (lines 1-255)
import type { Db } from "@/core/db";
import { exactCount, fetchAllRows } from "@/core/db";
import type { CoverageEntry as MatrixEntry } from "@/core/coverage/matrix";

export type IdentityState = "verified" | "unresolved" | "dead" | "pending";
/** The four machine-addressable surfaces the index publishes into (Community is human-operated). */
export const COVERAGE_SURFACES = ["regulations", "operations", "market_intel", "research"] as const;
export type CoverageSurface = (typeof COVERAGE_SURFACES)[number];

export interface CoverageIndexEntry extends MatrixEntry {
  id: string;
  url: string;
  identifier: string | null;
  /** The real captured title, else the notes descriptor, else the identifier: never a bare number once enriched. */
  displayTitle: string;
  title: string | null;
  jurisdiction: string | null;
  instrumentType: string | null;
  scheme: string | null;
  shapeValid: boolean;
  surfaces: string[];
  /** The transport modes of the instrument's SOURCE (the registry's own tag; empty when none, never guessed). */
  modes: string[];
  checkedAt: string | null;
  shapeClass: string | null;
  relevance: "firm" | "soft";
  softPass: 0 | 1 | 2;
  identity: IdentityState;
  hostRegistered: boolean;
}
export interface CoverageCounts {
  total: number;
  firmCore: number;
  softTail: number;
  identityVerified: number;
  identityUnresolved: number;
  identityDead: number;
  identityPending: number;
  /** Firm-core AND identity-verified: the prominent set. */
  dualVerified: number;
  distinctSources: number;
  distinctInstruments: number;
  bySurface: Record<string, number>;
  /** provenance_status='verified' corpus items: the separate, honest brief count. */
  verifiedBriefs: number;
}
interface SourceEmbed {
  jurisdiction_iso: string[] | null;
  transport_modes: string[] | null;
}
interface Row {
  id: string;
  document_url: string;
  instrument_identifier: string | null;
  title: string | null;
  source_id: string;
  shape_class: string | null;
  surface_tags: string[] | null;
  notes: string | null;
  identity_checked_at: string | null;
  identity_resolves: boolean | null;
  identity_scheme: string | null;
  identity_shape_valid: boolean | null;
  identity_host_registered: boolean | null;
  sources: SourceEmbed | SourceEmbed[] | null;
}

// The relevance band is parsed out of the free-text `notes` column ([low-relevance] tags): structured state in a text column, named debt (no column carries it yet).
const softPassOf = (notes: string | null): 0 | 1 | 2 => {
  const n = (notes || "").split("[low-relevance]").length - 1;
  return n >= 2 ? 2 : n === 1 ? 1 : 0;
};
/** Verified needs a confirmed resolve AND a registered host; dead is a confirmed failure; unresolved could not be confirmed; pending was never checked. Pending is not dead. */
function identityOf(row: Pick<Row, "identity_checked_at" | "identity_resolves" | "identity_host_registered">): IdentityState {
  if (!row.identity_checked_at) return "pending";
  if (row.identity_resolves === true) return row.identity_host_registered ? "verified" : "unresolved";
  return row.identity_resolves === false ? "dead" : "unresolved";
}
function parseNotes(notes: string | null): { instrumentType: string | null; descriptor: string | null } {
  const s = notes || "";
  const parts = s.split("::");
  return { instrumentType: s.match(/\btype=([a-z_]+)/i)?.[1]?.toLowerCase() ?? null, descriptor: parts.length > 1 ? parts.slice(1).join("::").trim() || null : null };
}
const SCHEME_JURIS: Record<string, string> = { celex: "EU", eli: "EU", "uk-legislation": "GB" };
/** The source's registered jurisdiction_iso, else derived from the identifier scheme, else null (honest, never guessed). */
const jurisdictionOf = (sourceIso: string | null, scheme: string | null): string | null => (sourceIso ? sourceIso.toUpperCase() : scheme && SCHEME_JURIS[scheme] ? SCHEME_JURIS[scheme] : null);

const COLUMNS = "id,document_url,instrument_identifier,title,source_id,shape_class,surface_tags,notes,identity_checked_at,identity_resolves,identity_scheme,identity_shape_valid,identity_host_registered,sources(jurisdiction_iso,transport_modes)";

/**
 * The surface's would_mint census, read ONCE: every row paginated under a total order, mapped to human-readable entries, exact counts, sorted (dual-verified firm-core first). Any read error throws,
 * including the verified-brief count: a failed count must not publish "0 verified briefs". Callers slice; the matrix build uses these same entries and counts (the census is not read twice).
 */
export async function loadCoverage(db: Db, surface?: CoverageSurface): Promise<{ entries: CoverageIndexEntry[]; counts: CoverageCounts }> {
  const rows = await fetchAllRows<Row>((from, to) => {
    let q = db.from("census_worklist").select(COLUMNS).eq("dryrun_disposition", "would_mint");
    if (surface) q = q.contains("surface_tags", [surface]);
    return q.order("id", { ascending: true }).range(from, to) as never;
  }, { cap: 500_000 });
  const verifiedBriefs = await exactCount(db.from("intelligence_items").select("id", { count: "exact", head: true }).eq("provenance_status", "verified").not("full_brief", "is", null) as never);
  const entries: CoverageIndexEntry[] = rows.map((r) => {
    const softPass = softPassOf(r.notes);
    const { instrumentType, descriptor } = parseNotes(r.notes);
    const src = Array.isArray(r.sources) ? r.sources[0] : r.sources;
    const iso = src?.jurisdiction_iso;
    return {
      id: r.id,
      url: r.document_url,
      identifier: r.instrument_identifier,
      displayTitle: r.title || descriptor || r.instrument_identifier || r.document_url,
      title: r.title,
      jurisdiction: jurisdictionOf(Array.isArray(iso) && iso.length ? (iso[0] ?? null) : null, r.identity_scheme),
      instrumentType,
      scheme: r.identity_scheme,
      shapeValid: r.identity_shape_valid === true,
      surfaces: r.surface_tags || [],
      modes: Array.isArray(src?.transport_modes) ? src.transport_modes.filter((m) => typeof m === "string" && m.trim() !== "") : [],
      checkedAt: r.identity_checked_at,
      shapeClass: r.shape_class,
      relevance: softPass === 0 ? "firm" : "soft",
      softPass,
      identity: identityOf(r),
      hostRegistered: r.identity_host_registered === true,
    };
  });
  const n = (f: (e: CoverageIndexEntry) => boolean) => entries.filter(f).length;
  const counts: CoverageCounts = {
    total: entries.length,
    firmCore: n((e) => e.relevance === "firm"),
    softTail: n((e) => e.relevance === "soft"),
    identityVerified: n((e) => e.identity === "verified"),
    identityUnresolved: n((e) => e.identity === "unresolved"),
    identityDead: n((e) => e.identity === "dead"),
    identityPending: n((e) => e.identity === "pending"),
    dualVerified: n((e) => e.relevance === "firm" && e.identity === "verified"),
    distinctSources: new Set(rows.map((r) => r.source_id)).size,
    distinctInstruments: new Set(rows.map((r) => r.instrument_identifier || r.document_url)).size,
    bySurface: { regulations: 0, operations: 0, market_intel: 0, research: 0 },
    verifiedBriefs,
  };
  for (const e of entries) for (const s of e.surfaces) if (s in counts.bySurface) counts.bySurface[s] = (counts.bySurface[s] ?? 0) + 1;
  const rank: Record<IdentityState, number> = { verified: 0, pending: 1, unresolved: 2, dead: 3 };
  entries.sort((a, b) => (a.relevance !== b.relevance ? (a.relevance === "firm" ? -1 : 1) : a.identity !== b.identity ? rank[a.identity] - rank[b.identity] : a.softPass - b.softPass));
  return { entries, counts };
}

export const INITIAL_CAP = 60;
/** The page-side read: exact counts and the initial entry slice. An outage is `_error`, never an empty index that reads as zero coverage. */
export async function getCoverageIndex(db: Db, surface?: CoverageSurface): Promise<{ entries: CoverageIndexEntry[]; cap: number; counts: CoverageCounts | null; _error?: string }> {
  try {
    const { entries, counts } = await loadCoverage(db, surface);
    return { entries: entries.slice(0, INITIAL_CAP), cap: INITIAL_CAP, counts };
  } catch (e) {
    return { entries: [], cap: INITIAL_CAP, counts: null, _error: `Coverage index temporarily unavailable: ${(e as Error).message}` };
  }
}
/** The full per-surface entry list for the admin route; throws on error so the route answers with a status. Read-only content: no promote or action field. */
export async function getCoverageEntries(db: Db, surface?: CoverageSurface): Promise<CoverageIndexEntry[]> {
  return (await loadCoverage(db, surface)).entries;
}
