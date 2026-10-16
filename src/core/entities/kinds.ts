// Ported from old_repo/src/lib/entities/entity-id-shape.mjs (lines 1-37)
// Ported from old_repo/src/lib/entities/decisions.mjs (lines 51-57)
// Ported from old_repo/scripts/entities/write-entity-scope.mjs (lines 22-32)
// Browser-safe: the closed list of entity kinds, the id shape check, the corridor id scheme and the ONE corridor-name parser. No hashing here
// (that needs node:crypto and lives in id.ts), so a client bundle can read a kind from an id without pulling a hash in (B-1025).
export const KINDS = ["corridor", "node", "jurisdiction", "organisation", "asset", "instrument", "obligation", "method", "technology", "signpost", "person", "material"] as const;
export type EntityKind = (typeof KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(KINDS);
const ID_RE = /^cl:([a-z_]+):([0-9a-f]{16})$/;

/** ADR-024: corridor identity is a UN/LOCODE port-pair plus a canonical mode, hashed. */
export const CORRIDOR_ID_SCHEME = Object.freeze({ basis: "UN/LOCODE port-pair + mode", seedFormat: "ORIGIN-DEST:mode", hashAlgorithm: "sha256", hashHexLength: 16, idPrefix: "cl:corridor:" });

/** Throws unless the id is `cl:<kind>:<16 hex>` with a known kind (and the expected one when given). */
export function assertEntityId(id: unknown, expectedKind?: EntityKind): true {
  const s = String(id ?? "");
  const m = ID_RE.exec(s);
  if (!m) throw new Error(`entity-id: "${s}" is not a well-formed entity id (expected cl:<kind>:<16 lowercase hex>)`);
  const kind = m[1] as string;
  if (!KIND_SET.has(kind)) throw new Error(`entity-id: "${s}" names kind "${kind}", which is not in KINDS (${KINDS.join(", ")})`);
  if (expectedKind && kind !== expectedKind) throw new Error(`entity-id: "${s}" is a "${kind}" entity id, expected "${expectedKind}"`);
  return true;
}

export const entityKindOf = (id: unknown): string | null => ID_RE.exec(String(id ?? ""))?.[1] ?? null;

const CORRIDOR_NAME_RE = /^([A-Z]{2}[A-Z2-9]{3})-([A-Z]{2}[A-Z2-9]{3}):([a-z_]+)$/;
export interface CorridorName {
  origin: string;
  dest: string;
  mode: string;
}
/** `CNSHA-NLRTM:ocean` to its parts; null for anything else (no lower-case tolerance: the seed is canonical). */
export function parseCorridorName(name: string | null | undefined): CorridorName | null {
  const m = CORRIDOR_NAME_RE.exec(String(name ?? ""));
  return m ? { origin: m[1] as string, dest: m[2] as string, mode: m[3] as string } : null;
}
