// The self-check scope rule. A migration's self-check runs on an empty CI database and, once, on production. A read of a public table (or a function over one) that is not scoped by something the self-check itself
// created reads whatever rows are there: nothing on the empty CI database (the assertion is vacuous), the live rows on production (the assertion races them and fails on the first re-run). `scopeProblems` parses each
// DO block into statements and rejects every statement that reads or writes a public table, or calls a public function, with none of these in scope:
//   - a PL/pgSQL variable the block declared (a fixture id), other than the target the statement's own INTO fills;
//   - a literal the block itself inserted (a fixture key), or a fixture marker (`selfcheck`, `.example`, `.invalid`, `.test`);
//   - an unprivileged role: after `SET LOCAL ROLE <role>` the read runs under that role's RLS, which is the attack the self-check exists to make (it sees only what the fixture identity may see).
// The old rule matched `SELECT ... INTO v FROM public.t ... LIMIT 1` only; a sub-select, a count, an unqualified table and a loop all passed. A named waiver (apply-notes `unscopedReads`: table to the reason it is a
// whole-table invariant or already superseded by a later file) is the only exception.
import { splitStatements } from "../sql-split.mjs";

const FIXTURE_LITERAL = /selfcheck|\.example\b|\.invalid\b|\.test\b/i;
const PRIVILEGED = new Set(["postgres", "service_role", "supabase_admin", "none", "default"]);

/** The DO blocks of a migration (statement text), in order. */
export const doBlocks = (text) => splitStatements(text).map((s) => s.sql).filter((s) => /^DO\b/i.test(s));

const strip = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const words = (sql) => new Set([...sql.replace(/'(?:[^']|'')*'/g, " ").toLowerCase().matchAll(/\b[a-z_]\w*\b/g)].map((m) => m[0]));
const literalsOf = (sql) => [...sql.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]);

/** The PL/pgSQL variables a DO block declares (DECLARE section and FOR loop variables), lower-cased. */
export function declaredVariables(body) {
  const decl = /\bDECLARE\b([\s\S]*?)\bBEGIN\b/i.exec(body)?.[1] ?? "";
  const vars = new Set([...decl.matchAll(/(?:^|[;,\s])(\w+)\s+(?:CONSTANT\s+)?[\w.]+(?:\[\])?(?:\([\d,\s]+\))?\s*(?::=|=|;|,|DEFAULT|NOT)/gi)].map((m) => m[1].toLowerCase()));
  for (const m of body.matchAll(/\bFOR\s+(\w+)\s+IN\b/gi)) vars.add(m[1].toLowerCase());
  for (const kw of ["begin", "end", "if", "then", "else", "declare", "select", "from", "where", "into", "and", "or", "not", "null", "true", "false"]) vars.delete(kw);
  return vars;
}

/**
 * The problems of one migration's DO blocks. `tables` and `functions` are the public relation and function names; `waivers` maps a table to the reason its unscoped read is allowed. Each problem names the table and
 * quotes the statement.
 */
export function scopeProblems(text, { tables, functions, waivers = {} }) {
  const problems = [];
  for (const block of doBlocks(text)) {
    const body = strip(block.replace(/^DO\s+(\$\w*\$)/i, "").replace(/\$\w*\$\s*(?:LANGUAGE\s+\w+\s*)?$/i, ""));
    const vars = declaredVariables(body);
    const statements = splitStatements(body.replace(/\b(BEGIN|EXCEPTION|END|THEN|ELSE|LOOP)\b/gi, ";")).map((s) => s.sql);
    // The literals the block inserts are its fixture keys.
    const inserted = new Set(statements.filter((s) => /^INSERT\b/i.test(s)).flatMap(literalsOf).filter((l) => l.length > 1));
    let underRole = false;
    for (const [at, sql] of statements.entries()) {
      const setRole = /^SET\s+(?:LOCAL\s+)?ROLE\s+"?(\w+)"?/i.exec(sql);
      if (setRole) underRole = !PRIVILEGED.has(setRole[1].toLowerCase());
      else if (/^RESET\s+ROLE\b/i.test(sql) && !/^RAISE\b/i.test(statements[at + 1] ?? "")) underRole = false; // `RESET ROLE; RAISE ...` is the failure branch of an IF: the role stays for the code after it
      // What the statement itself fills (INTO, the loop variable of its own FOR) is not a scope for it: `FOR r IN SELECT ... FROM public.t LOOP` names r in the very statement that reads t.
      const targets = new Set([...sql.matchAll(/\bINTO\s+(\w+)/gi), ...sql.matchAll(/\bFOR\s+(\w+)\s+IN\b/gi)].map((m) => m[1].toLowerCase()));
      const refs = [];
      let throughFunction = false;
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|UPDATE)\s+(?:public\.)?(\w+)(\s*\()?/gi)) {
        const name = m[1].toLowerCase();
        if (m[2] ? functions.has(name) : tables.has(name)) refs.push(name);
        if (m[2] && functions.has(name)) throughFunction = true;
      }
      if (!refs.length) continue;
      const used = words(sql);
      const literals = literalsOf(sql);
      // RLS bounds a table read under a role; a function may be a SECURITY DEFINER aggregate over every row, so the role scopes nothing for it.
      const scoped = (underRole && !throughFunction) || [...vars].some((v) => !targets.has(v) && used.has(v)) || FIXTURE_LITERAL.test(literals.join(" ")) || literals.some((l) => inserted.has(l));
      if (scoped) continue;
      for (const name of new Set(refs)) if (!waivers[name]) problems.push(`the self-check reads ${name} with nothing the fixture created in its scope: ${sql.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return problems;
}
