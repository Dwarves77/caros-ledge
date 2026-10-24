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

/** ARM-2 (S4): the two producers that fetched with no register entry (ecb-fx, ukpn-capacity-heatmap) get theirs, so INV-ARM-1 covers them. ecb already has a production row (migration 281, licence text unconfirmed); the upsert replaces it with the notice as read. */
export const ARM2_KEYS = ["ecb", "ukpn_ltds_capacity_heatmap"] as const;
export const ARM2_MIGRATION_FILE = "supabase/migrations/0125_licence_register_ecb_ukpn.sql";
export const ARM2_DOWN_FILE = "supabase/migrations/down/0125.sql";
const ARM2_ID = "0125-licence-register-ecb-ukpn";

export function renderArm2Migration(): string {
  const keys = ARM2_KEYS;
  const on = SOURCE_LICENCES.ecb?.verifiedOn;
  return `-- 0125 licence_register_ecb_ukpn: the data_sources rows for the two structured-data producers that fetched under no register entry (ARM-2, notices read ${on}).
--
-- Before: ecb-fx and ukpn-capacity-heatmap named no licence key, so the runner's licence gate (INV-ARM-1) had nothing to check; the ecb row (migration 281) carried a licence text its own blocker called unconfirmed, and the UKPN heatmap had no row.
-- After: both carry the verdict their publisher's own notice gives, read ${on}: the ECB Disclaimer & copyright page (free use provided the information appears accurately and the ECB is cited) and the dataset's catalogue licence field (CC BY 4.0).
-- The rows are rendered from src/core/contracts/data/source-licences.json through renderDataSourceSeedSql, restricted to these two keys; tests/golden/_migration.ts renders this file again and tests/producers/arm2.test.ts compares it byte for byte.
-- Regenerate with GOLDEN_WRITE_MIGRATION=1 npm test. The statement is idempotent (ON CONFLICT DO UPDATE).
-- Access: unchanged.
--
-- Reversal: supabase/migrations/down/0125.sql (deletes the UKPN row and puts the ecb row back as migration 281 wrote it).

-- catalog: none

BEGIN;

${seedFor(keys)}

-- Self-check ${ARM2_ID}, in the transaction that wrote the rows: each key is present, permitted and embeddable, carries the day its notice was read and no blocker, and is not doubled.
DO $$
DECLARE
  keys text[] := ARRAY[${keys.map(lit).join(", ")}];
  k text;
  r record;
  v_ukpn text := 'ukpn_ltds_capacity_heatmap';
BEGIN
  FOREACH k IN ARRAY keys LOOP
    SELECT redistribution, embeddable, verified_on, blocker, licence INTO r FROM public.data_sources WHERE source_key = k;
    IF NOT FOUND THEN RAISE EXCEPTION '${ARM2_ID}: % is missing', k; END IF;
    IF r.redistribution IS DISTINCT FROM 'permitted' OR r.embeddable IS DISTINCT FROM true THEN RAISE EXCEPTION '${ARM2_ID}: % is not permitted and embeddable', k; END IF;
    IF r.verified_on IS DISTINCT FROM DATE '${on}' OR r.blocker IS NOT NULL THEN RAISE EXCEPTION '${ARM2_ID}: % does not carry its read date and no blocker', k; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.data_sources WHERE source_key = ANY (keys)) <> ${keys.length} THEN
    RAISE EXCEPTION '${ARM2_ID}: the ${keys.length} register rows are not all present';
  END IF;
  IF (SELECT licence FROM public.data_sources WHERE source_key = v_ukpn) IS DISTINCT FROM 'CC BY 4.0' THEN
    RAISE EXCEPTION '${ARM2_ID}: the UKPN heatmap licence is not CC BY 4.0';
  END IF;
  RAISE NOTICE '${ARM2_ID} OK';
END $$;

COMMIT;
`;
}

/** Down for 0125: the UKPN row goes; the ecb row returns to what migration 281 wrote (its unconfirmed licence text, no read date, its blocker). */
export function renderArm2Down(): string {
  return `-- Down for 0125_licence_register_ecb_ukpn: the UKPN heatmap row goes and the ecb row is put back as migration 281 wrote it.
DELETE FROM public.data_sources WHERE source_key = 'ukpn_ltds_capacity_heatmap';
UPDATE public.data_sources SET licence = ${lit("ECB legal/copyright notice (ecb.europa.eu site-wide): reproduction is permitted provided the source is acknowledged")}, verified_on = NULL, blocker = ${lit("licence text [UNCONFIRMED until first runner dry run reads the ECB notice] — sandbox egress to every ecb.europa.eu host returned a 403 policy denial this session; the verdict above is transcribed from the ECB's own well-documented standing notice, not a fetch performed this session. See this migration's own header and ecb-fx-producer.mjs's header for the full citation.")} WHERE source_key = 'ecb';
`;
}
