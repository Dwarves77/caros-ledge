// The verdicts of the property checks, pure functions of the rows a check returned (scripts/ci/properties.mjs runs the SQL and prints what these say).
//   - A waiver NAMES its offenders: `{ slice, date, reason, offenders: ["<the exact row>", ...] }`. A count would let a new offender replace a waived one and pass; a named row cannot be replaced. A row the check returns that no
//     waiver names fails; a waived row the check no longer returns fails too (delete it): the list only shrinks.
//   - A planted violation says what it plants: each `-- expect: <text>` line of scripts/ci/fixtures/<key>.sql is the start of a row the check must return once the fixture is applied, one line per branch of the check.
//     A fixture with no expect line, an expectation no new row meets (a branch removed from the fixture, or a branch of the check that stopped working), and a new row no expectation names all fail.

/**
 * The SQL expression for "the schemas the app reads": every schema in the database that is not the platform's (the production shape lists the platform's own) plus `public`. It is an array expression (the cast keeps `= ANY (...)` from reading it as a subquery) evaluated where it is used, so
 * a schema a planted fixture creates is inside the transaction's answer, and a migration that creates a schema is covered the day it merges.
 */
export function appSchemasSql(platformSchemas) {
  const platform = platformSchemas.filter((s) => s !== "public").map((s) => `'${s.replace(/'/g, "''")}'`);
  return `(SELECT coalesce(array_agg(nspname ORDER BY nspname), '{}') FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema' AND nspname <> ALL (ARRAY[${platform.join(", ")}]::name[]))::name[]`;
}

/** The `-- expect:` texts of a fixture. */
export const expectationsOf = (fixtureText) => [...fixtureText.matchAll(/^-- expect: (.+)$/gm)].map((m) => m[1].trim());

/** Problems with the shape of the waiver file against the checks on disk (`keys`). */
export function waiverShapeProblems(waivers, keys) {
  const problems = [];
  for (const [key, w] of Object.entries(waivers)) {
    if (!keys.includes(key)) problems.push(`waiver ${key}: there is no such check (scripts/ci/checks/${key}.sql)`);
    if (!/^P\d-[A-Z0-9]+$/.test(w.slice ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(w.date ?? "")) problems.push(`waiver ${key}: needs slice (e.g. P2-S1) and date (YYYY-MM-DD)`);
    if (typeof w.reason !== "string" || !w.reason.trim()) problems.push(`waiver ${key}: needs a reason (why the offender stands)`);
    if (!Array.isArray(w.offenders) || !w.offenders.length || w.offenders.some((o) => typeof o !== "string" || !o.trim())) problems.push(`waiver ${key}: offenders must list each waived row by name (a count is not a waiver)`);
  }
  return problems;
}

/** The verdict on the live rows of one check: { status: "PASS" | "WAIVED" | "FAIL", problems, waived }. */
export function judgeRows(key, rows, waiver) {
  const named = new Set(waiver?.offenders ?? []);
  const fresh = rows.filter((r) => !named.has(r));
  const stale = [...named].filter((o) => !rows.includes(o));
  const problems = [...fresh.map((r) => `${key}: ${r} (not waived: a new offender)`), ...stale.map((o) => `${key}: waiver names "${o}", which the check no longer returns: delete it`)];
  const status = problems.length ? "FAIL" : rows.length ? "WAIVED" : "PASS";
  return { status, problems, waived: rows.filter((r) => named.has(r)) };
}

/** The problems with a planted run: `planted` is every row the check returned with the fixture applied, `live` the rows it returned without. */
export function attackProblems(key, fixtureText, planted, live) {
  if (fixtureText === null) return [`ATTACK FAILED ${key}: no planted violation in scripts/ci/fixtures/${key}.sql`];
  const expects = expectationsOf(fixtureText);
  if (!expects.length) return [`ATTACK FAILED ${key}: the fixture lists no \`-- expect:\` line: say which row each branch of the check returns`];
  const hits = planted.filter((r) => !live.includes(r));
  return [
    ...expects.filter((e) => !hits.some((h) => h.startsWith(e))).map((e) => `ATTACK FAILED ${key}: the planted violation did not produce a row starting "${e}"`),
    ...hits.filter((h) => !expects.some((e) => h.startsWith(e))).map((h) => `ATTACK FAILED ${key}: the fixture produced a row it does not expect: ${h}`),
  ];
}
