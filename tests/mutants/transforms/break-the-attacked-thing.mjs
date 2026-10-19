// The mutation behind the registry entries of the migrations that change nothing (scripts/ci/schema/selfcheck-mutants.mjs): a self-check that attacks objects other migrations made has no change to remove, so the mutation
// breaks the thing the attack is aimed at, before the file runs. The self-check must then raise its own assertion (SQLSTATE P0001); a self-check that still passes proves nothing.
// The file is recognised by the id its OK notice prints.
import { selfCheckIdOf } from "../../../scripts/lib/migrations.mjs";

const BREAKERS = {
  // 0060 attacks the row-level security of the Community tables: with it off on profiles, attack 1 reads another organisation's row
  "0060-rls-attacks": (text) => `ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;\n${text}`,
  // 0062 walks the Community journey: with the triggers that keep the counters gone, step 5 finds a reply count of 0
  "0062-round-trip": (text) =>
    `DO $mutant$ DECLARE t record; BEGIN FOR t IN SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.community_posts'::regclass AND NOT tgisinternal LOOP EXECUTE format('DROP TRIGGER %I ON public.community_posts', t.tgname); END LOOP; END $mutant$;\n${text}`,
  // 0073 re-proves five earlier checks; the last clause is the live check of 0069: the function 0068 made does not report trigger_enabled
  "0073-selfcheck-repairs": (text) =>
    `CREATE OR REPLACE FUNCTION public.live_check_provenance_trigger() RETURNS jsonb LANGUAGE sql AS $mutant$ SELECT '{"flipped": true, "before": "verified", "after": "pending", "left_behind": 0}'::jsonb $mutant$;\n${text}`,
  // 0072 asserts the six market series exist: run without the fixture that planted them, none does
  "0072-market-series": (text) => ({ text, fixture: false }),
};

export function mutate(text) {
  const id = selfCheckIdOf(text, "0000_x.sql");
  const breaker = BREAKERS[id];
  return breaker ? breaker(text) : null;
}
