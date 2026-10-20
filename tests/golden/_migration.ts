import { SOURCE_LICENCES, renderDataSourceSeedSql } from "@/core/contracts/source-licence";

/** The register keys R2g added (2026-10-20): the rows migration 0082 seeds into public.data_sources. */
export const R2G_KEYS = [
  "ghgprotocol_org",
  "ecotransit_org",
  "consilium_europa_eu",
  "ec_climate_europa_eu",
  "ec_taxation_customs_europa_eu",
  "mardep_gov_hk",
  "icao_int",
  "mcga_gov_uk",
  "cbp_gov",
] as const;

export const MIGRATION_FILE = "supabase/migrations/0082_licence_register_r2g.sql";
export const DOWN_FILE = "supabase/migrations/down/0082.sql";
const ID = "0082-licence-register-r2g";
const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** The seed rows of exactly these keys, cut out of the one text renderDataSourceSeedSql renders (never retyped), with the statement's own conflict clause. */
function seedFor(keys: readonly string[]): string {
  const lines = renderDataSourceSeedSql().split("\n");
  const rows = lines.filter((l) => /^ {2}\('/.test(l));
  const keep = keys.map((k) => {
    const hits = rows.filter((l) => l.startsWith(`  (${lit(k)}, `));
    if (hits.length !== 1) throw new Error(`the rendered seed has ${hits.length} rows for ${k}`);
    return (hits[0] as string).replace(/,$/, "");
  });
  const tail = lines.slice(lines.findIndex((l) => l.startsWith("ON CONFLICT")));
  const head = lines.slice(lines.findIndex((l) => l.startsWith("INSERT INTO")), lines.findIndex((l) => l === "VALUES") + 1);
  return [...head, keep.join(",\n"), ...tail].join("\n");
}

/** Migration 0082 as it must be on disk: the seed of the nine keys and a self-check that reads each row back against the register. */
export function renderMigration(keys: readonly string[] = R2G_KEYS): string {
  const verdicts = keys.map((k) => SOURCE_LICENCES[k]?.redistribution ?? "");
  if (verdicts.some((v) => !v)) throw new Error("a key is not in the register");
  const through = [...keys.map((k) => SOURCE_LICENCES[k]?.verifiedOn ?? "")].sort().at(-1);
  return `-- 0082 licence_register_r2g: the data_sources rows for the golden corpus publishers (R2g, notices read ${through}).
--
-- Before: the nine publishers behind the golden corpus had no register entry, so the licence gate refused them as unregistered and public.data_sources, which the factor tables and the item surfaces read for the verdict
-- and the attribution, did not know them. After: one row per publisher host, each carrying the verdict its own legal notice gave, its terms URL, the date read and the attribution text a permitted licence requires.
-- The rows are rendered from src/core/contracts/data/source-licences.json through renderDataSourceSeedSql (src/core/contracts/source-licence.ts), restricted to these nine keys; tests/golden/_migration.ts renders this
-- file again and tests/golden/licence-register.test.ts compares it byte for byte. Never edited by hand; regenerate with GOLDEN_WRITE_MIGRATION=1 npm test. The statement is idempotent (ON CONFLICT DO UPDATE).
-- Access: unchanged. Not applied to production before the cutover window.
--
-- Reversal: supabase/migrations/down/0082.sql (deletes the nine rows).

-- catalog: none

BEGIN;

${seedFor(keys)}

-- Self-check ${ID}, in the transaction that wrote the rows: each of the nine keys is present with exactly the verdict the register gives it, and no key is missing or doubled.
DO $$
DECLARE
  keys text[] := ARRAY[${keys.map(lit).join(", ")}];
  verdicts text[] := ARRAY[${verdicts.map(lit).join(", ")}];
  i int;
  v text;
BEGIN
  FOR i IN 1..array_length(keys, 1) LOOP
    SELECT redistribution INTO v FROM public.data_sources WHERE source_key = keys[i];
    IF v IS DISTINCT FROM verdicts[i] THEN
      RAISE EXCEPTION '${ID}: % is % in data_sources, the register says %', keys[i], v, verdicts[i];
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.data_sources WHERE source_key = ANY (keys)) <> ${keys.length} THEN
    RAISE EXCEPTION '${ID}: the ${keys.length} register rows are not all present';
  END IF;
  RAISE NOTICE '${ID} OK';
END $$;

COMMIT;
`;
}

/** Down for 0082: the nine rows go; nothing references them (they are new keys no factor row carries). */
export function renderDown(keys: readonly string[] = R2G_KEYS): string {
  return `-- Down for 0082_licence_register_r2g: the nine data_sources rows R2g seeded go.\nDELETE FROM public.data_sources WHERE source_key IN (${keys.map(lit).join(", ")});\n`;
}
