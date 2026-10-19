import assert from "node:assert/strict";
import test from "node:test";

import { selfCheckStructureProblems } from "../../scripts/ci/migration-checks.mjs";
import { shapeDiff } from "../../scripts/ci/schema/shape.mjs";
import { scopeProblems } from "../../scripts/ci/schema/self-check-scope.mjs";
import { changesDatabase, lastDoIndex, statementsOf } from "../../scripts/ci/schema/statements.mjs";

const TABLES = new Set(["profiles", "intelligence_items"]);
const check = (body, waivers = {}) => scopeProblems(`DO $$\nDECLARE fixture uuid := gen_random_uuid(); n int;\nBEGIN\n${body}\nEND $$;`, { tables: TABLES, functions: new Set(), waivers });

test("what changes the database: DDL, DML and a WITH that ends in one; a SELECT, a WITH that only reads and a temporary table do not", () => {
  for (const sql of ["CREATE TABLE public.t (id int)", "ALTER TABLE public.t ADD COLUMN c int", "UPDATE public.t SET c = 1", "INSERT INTO public.t VALUES (1)", "WITH parts AS (SELECT id FROM public.t) UPDATE public.t m SET c = 1 FROM parts p WHERE m.id = p.id"]) {
    assert.equal(changesDatabase(sql), true, sql);
  }
  for (const sql of ["SELECT 1", "WITH x AS (SELECT 1) SELECT * FROM x", "CREATE TEMP TABLE _t (id int)", "INSERT INTO _t VALUES (1)"]) assert.equal(changesDatabase(sql), false, sql);
  const statements = statementsOf("CREATE TABLE a (id int);\nDO $$ BEGIN NULL; END $$;\nUPDATE a SET id = 1;\nDO $$ BEGIN RAISE NOTICE 'x OK'; END $$;");
  assert.equal(lastDoIndex(statements), 3);
});

test("the self-check scope rule: a read of a public table scoped by nothing the fixture made is a problem, in every shape the old rule missed", () => {
  assert.match(check("SELECT count(*) INTO n FROM public.profiles;").join("\n"), /reads profiles with nothing the fixture created in its scope/);
  assert.match(check("SELECT count(*) INTO n FROM profiles;").join("\n"), /reads profiles/, "an unqualified table");
  assert.match(check("SELECT count(*) INTO n FROM (SELECT id FROM public.profiles LIMIT 1) s;").join("\n"), /reads profiles/, "a sub-select");
  assert.match(check("FOR r IN SELECT id FROM public.intelligence_items LOOP n := n + 1; END LOOP;").join("\n"), /reads intelligence_items/, "a loop");
});

test("the self-check scope rule: a fixture variable, a fixture literal, an unprivileged role and a named waiver each scope a read; a variable the statement only fills does not", () => {
  assert.deepEqual(check("SELECT count(*) INTO n FROM public.profiles WHERE id = fixture;"), []);
  assert.deepEqual(check("SELECT count(*) INTO n FROM public.profiles WHERE email = 'a@selfcheck.example';"), []);
  assert.deepEqual(check("SET LOCAL ROLE authenticated;\nSELECT count(*) INTO n FROM public.profiles;"), []);
  assert.deepEqual(check("SELECT count(*) INTO n FROM public.profiles;", { profiles: "a whole-table invariant" }), []);
  assert.match(check("SELECT id INTO fixture FROM public.profiles LIMIT 1;").join("\n"), /reads profiles/, "the INTO target is not a scope");
});

test("shapeDiff: equal shapes agree whatever the key order; a role setting that differs, a role that is missing and a different owner are each named, with the names the caller gives the two sides", () => {
  const shape = { roles: [{ name: "anon", login: false }], memberships: [], roleSettings: [{ role: "authenticator", database: "*", settings: ["statement_timeout=8s"] }], schemaAcls: [], defaultAcls: [], serverSettings: { max_rows: "1000" }, databaseOwner: "postgres" };
  assert.deepEqual(shapeDiff(shape, structuredClone(shape)), []);
  assert.deepEqual(shapeDiff(shape, { ...structuredClone(shape), roles: [{ login: false, name: "anon" }] }), [], "key order is not a difference");
  const drifted = structuredClone(shape);
  drifted.roleSettings[0].settings = ["statement_timeout=30s"];
  drifted.roles = [];
  drifted.databaseOwner = "supabase_admin";
  const found = shapeDiff(shape, drifted, { want: "production-shape.json", have: "production" }).join("\n");
  assert.match(found, /roleSettings: authenticator@\*: production-shape\.json .*8s.*; production .*30s/);
  assert.match(found, /roles: anon: production-shape\.json has .*; production has none/);
  assert.match(found, /databaseOwner: production-shape\.json postgres; production supabase_admin/);
  assert.match(shapeDiff(shape, drifted).join("\n"), /this database/, "the default names are production and this database");
});

test("a self-check whose RAISE EXCEPTION sits only in a comment or a string can only pass, and is refused; one that can raise is accepted", () => {
  const file = (body) => `-- Self-check 9999-x\nBEGIN;\nCREATE TABLE t (id int);\nDO $$ BEGIN\n${body}\nRAISE NOTICE '9999-x OK';\nEND $$;\nCOMMIT;\n`;
  for (const body of ["-- RAISE EXCEPTION never", "/* RAISE EXCEPTION never */ NULL;", "PERFORM 'RAISE EXCEPTION';"]) {
    assert.match(selfCheckStructureProblems("9999_x.sql", file(body)).join("|"), /no RAISE EXCEPTION/, body);
  }
  assert.deepEqual(selfCheckStructureProblems("9999_x.sql", file("IF false THEN RAISE EXCEPTION 'it--x'; END IF;")), []);
});
