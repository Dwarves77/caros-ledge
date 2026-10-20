// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 25-292)
// Document identity from a census row and its source: the CELEX sector map, the UK series identifier (the URL path ONLY), the
// Federal Register document number and type, and the registered-institution fallback. Pure and deterministic; the two helpers it
// needs from other slices (canonical-key derivation, institution equality) arrive as parameters.

/** CELEX sector digit to the letter-to-item_type map valid for that sector. A CELEX Decision is a binding act (Article 288 TFEU): regulation. */
const CELEX_SECTOR_LETTER_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "2": { A: "framework", D: "regulation" },
  "3": { R: "regulation", L: "directive", D: "regulation", H: "guidance", A: "framework" },
  "4": { D: "regulation" },
};
const CELEX_SHAPE = /^[1-9]\d{4}[A-Z]\d{4}/;

/**
 * item_type from a CELEX-shaped key. Two DIFFERENT holds, never conflated: `canonical_key_unresolved` (not CELEX-shaped: the key
 * was never resolved) and `item_type_unmapped` (a real key whose sector or letter has no home: named, never guessed).
 */
function classifyItemTypeFromCelexKey(canonicalKey: string | null | undefined): { itemType: string | null; hold: string | null } {
  if (typeof canonicalKey !== "string" || !CELEX_SHAPE.test(canonicalKey)) return { itemType: null, hold: "canonical_key_unresolved" };
  const itemType = CELEX_SECTOR_LETTER_MAP[canonicalKey.charAt(0)]?.[canonicalKey.charAt(5)] ?? null;
  return itemType ? { itemType, hold: null } : { itemType: null, hold: "item_type_unmapped" };
}

/** The legislation.gov.uk series-code vocabulary (UK statutory instrument and act families). */
const UK_TYPES: ReadonlySet<string> = new Set(["uksi", "ukpga", "ukla", "ukcm", "ukmo", "asp", "asc", "anaw", "mwa", "nia", "nisr", "ssi", "wsi", "apni", "aosp", "aep", "gbla", "mnia", "apgb", "aip"]);
const UK_TYPE_RE = /\/(uksi|ukpga|wsi|ssi|nisr)\//i;
const UK_ID_RE = new RegExp(`/(${[...UK_TYPES].join("|")})/(\\d{4})/(\\d+)`, "i");
const FR_DOCNUM_RE = /\/documents\/\d{4}\/\d{2}\/\d{2}\/([A-Za-z0-9-]+)/;

/** item_type for a legislation.gov.uk URL path segment (regulation for the statutory-instrument family), or null. */
const classifyUkLegislationType = (documentUrl: string | null | undefined): string | null => (UK_TYPE_RE.test(String(documentUrl ?? "")) ? "regulation" : null);
/**
 * "UK <type> <year>/<number>" from the URL's own path segment: the ONLY authoritative source for the series code (a Welsh /wsi/
 * instrument was once mislabeled "UK uksi" from a stale value). null when no recognised segment is present; never defaulted.
 */
function deriveUkLegislationIdentifier(documentUrl: string | null | undefined): string | null {
  const m = String(documentUrl ?? "").match(UK_ID_RE);
  return m ? `UK ${(m[1] ?? "").toLowerCase()} ${m[2]}/${m[3]}` : null;
}
/** The Federal Register document number out of a /documents/YYYY/MM/DD/<docnum>/ path, or null (held, never guessed). */
const extractFrDocumentNumber = (documentUrl: string | null | undefined): string | null => String(documentUrl ?? "").match(FR_DOCNUM_RE)?.[1] ?? null;
/** Federal Register API `type` to item_type: Rule is a regulation, Proposed Rule an initiative; every other type holds item_type_unmapped. */
function classifyFrDocType(frType: string | null | undefined): { itemType: string | null; hold: string | null } {
  const t = String(frType ?? "").trim().toLowerCase();
  return t === "rule" ? { itemType: "regulation", hold: null } : t === "proposed rule" ? { itemType: "initiative", hold: null } : { itemType: null, hold: "item_type_unmapped" };
}
const hostnameOf = (url: string | null | undefined): string | null => {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return null;
  }
};
/** Which source family a URL belongs to; null means held identity_unmapped_source with the host recorded. */
export function classifyHost(url: string | null | undefined): "eurlex" | "uk_legislation" | "federal_register" | null {
  const host = hostnameOf(url);
  if (!host) return null;
  return host.endsWith("eur-lex.europa.eu") ? "eurlex" : host.endsWith("legislation.gov.uk") ? "uk_legislation" : host.endsWith("federalregister.gov") ? "federal_register" : null;
}

export interface CensusRow { document_url?: string | null; instrument_identifier?: string | null }
export interface IdentitySource { url?: string | null; category?: string | null }
export interface DocumentIdentity {
  scheme: string | null;
  canonicalKey: string | null;
  itemType: string | null;
  jurisdictionIso: string | null;
  hold: string | null;
  host: string | null;
  instrumentIdentifier?: string | null;
  needsFrLookup?: boolean;
  frDocumentNumber?: string;
  frType?: string;
  category?: string | null;
}
/** The two helpers other slices own: canonical-key derivation (harness) and institution equality (sources). */
export interface IdentityHelpers {
  deriveKey(identifier: string | null, url: string | null): string | null;
  sameInstitution(a: string | null | undefined, b: string | null | undefined): boolean;
}

/**
 * Per-family identity resolution. Federal Register's item_type genuinely needs an external API value: until `frDocType` is given this
 * returns `needsFrLookup` and the document number instead of guessing, and the CALLER (which owns the network call) calls again.
 * A host no family claims is not automatically unmapped: a document of the SAME registered institution as its source defaults to a
 * regulation only when the source's category is regulatory, else it holds institution_category_unmapped naming the category.
 */
export function resolveDocumentIdentity(censusRow: CensusRow | null | undefined, source: IdentitySource | null | undefined, helpers: IdentityHelpers, opts: { frDocType?: string } = {}): DocumentIdentity {
  const documentUrl = censusRow?.document_url ?? null;
  const host = hostnameOf(documentUrl) ?? hostnameOf(source?.url) ?? null;
  const family = classifyHost(documentUrl) ?? classifyHost(source?.url);
  if (family === "eurlex") {
    const canonicalKey = helpers.deriveKey(censusRow?.instrument_identifier ?? null, documentUrl);
    const { itemType, hold } = classifyItemTypeFromCelexKey(canonicalKey);
    return { scheme: "celex", canonicalKey, itemType, jurisdictionIso: "EU", hold, host };
  }
  if (family === "uk_legislation") {
    const itemType = classifyUkLegislationType(documentUrl);
    return { scheme: "uk_legislation", canonicalKey: null, itemType, jurisdictionIso: "GB", hold: itemType ? null : "item_type_unmapped", host, instrumentIdentifier: deriveUkLegislationIdentifier(documentUrl) };
  }
  if (family === "federal_register") {
    const frDocumentNumber = extractFrDocumentNumber(documentUrl);
    if (!frDocumentNumber) return { scheme: "federal_register", canonicalKey: null, itemType: null, jurisdictionIso: "US", hold: "fr_document_number_unresolved", host };
    if (opts.frDocType === undefined) return { scheme: "federal_register", canonicalKey: frDocumentNumber, itemType: null, jurisdictionIso: "US", hold: null, host, needsFrLookup: true, frDocumentNumber };
    const { itemType, hold } = classifyFrDocType(opts.frDocType);
    return { scheme: "federal_register", canonicalKey: frDocumentNumber, itemType, jurisdictionIso: "US", hold, host, frType: opts.frDocType, frDocumentNumber };
  }
  if (helpers.sameInstitution(documentUrl, source?.url)) {
    return source?.category === "regulatory"
      ? { scheme: "registered_institution", canonicalKey: null, itemType: "regulation", jurisdictionIso: null, hold: null, host, category: source.category }
      : { scheme: null, canonicalKey: null, itemType: null, jurisdictionIso: null, hold: "institution_category_unmapped", host, category: source?.category ?? null };
  }
  return { scheme: null, canonicalKey: null, itemType: null, jurisdictionIso: null, hold: "identity_unmapped_source", host };
}
