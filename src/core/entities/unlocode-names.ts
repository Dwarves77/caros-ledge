// Ported from old_repo/src/lib/entities/unlocode-names.mjs (lines 10-86)
// Place names for the UN/LOCODEs in use, the corridor labels built from them, and country names for ISO 3166-1 codes. The names are data (data/unlocode-names.json) and every entry names the data source it came from: ports from
// GeoNames (CC BY 4.0, the credit travels with attributionsFor), countries from Wikidata (CC0). Nothing is served from a source the licence register does not allow: unlocodeName and nameForJurisdiction ask licenceGate for the
// entry's source key on every call (unlocode-table.ts) and return null when it refuses (INV-R2e-5), so a table pointed at the prohibited `un_locode` serves no name at all. A code with no name is the caller's raw code, never a guess.
import { nameTable } from "./unlocode-table";
import raw from "./data/unlocode-names.json";

export const { unlocodeName, nameForJurisdiction, formatCorridorLabel, formatCorridorLabelCompact, sources: nameSources } = nameTable(raw);
