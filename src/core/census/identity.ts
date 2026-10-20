// Ported from old_repo/src/lib/coverage/identity.mjs (lines 15-52)
const CELEX_RE = /^[0-9CE]\d{4}[A-Z]{1,2}\d{2,4}(?:\(\d{2}\))?$/;
const ELI_RE = /\beli\/[a-z_]+\/\d{4}\/[0-9a-z_-]+/i;
/** The legislation.gov.uk series codes: the one UK vocabulary, reused by target matching and the census, never re-enumerated. */
const UK_TYPES: ReadonlySet<string> = new Set(["uksi", "ukpga", "ukla", "ukcm", "ukmo", "asp", "asc", "anaw", "mwa", "nia", "nisr", "ssi", "wsi", "apni", "aosp", "aep", "gbla", "mnia", "apgb", "aip"]);

export type IdentifierScheme = "celex" | "eli" | "uk-legislation" | "generic" | "none";
/** An instrument identifier's scheme, whether its shape checks out, and its normalised form. A generic or empty identifier falls to URL-only identity. */
export function classifyIdentifier(identifier: unknown): { scheme: IdentifierScheme; shapeValid: boolean; normalized: string } {
  const raw = String(identifier || "").trim();
  if (!raw) return { scheme: "none", shapeValid: false, normalized: "" };
  const compact = raw.replace(/\s+/g, "");
  if (CELEX_RE.test(compact)) return { scheme: "celex", shapeValid: true, normalized: compact };
  if (ELI_RE.test(raw)) return { scheme: "eli", shapeValid: true, normalized: raw.toLowerCase() };
  const m = raw.toLowerCase().replace(/^uk[\s/]+/, "").match(/^([a-z]+)[\s/]+(\d{4})[\s/]+(\d+)$/);
  if (m && UK_TYPES.has(m[1] ?? "")) return { scheme: "uk-legislation", shapeValid: true, normalized: `${m[1]}/${m[2]}/${m[3]}` };
  return { scheme: "generic", shapeValid: false, normalized: raw };
}
