// The citation verifier (CITE-1): a document that cites a file, a line range or a `table.column` the tree does not have turns the gate red. Briefs and review documents cited phantom paths (src/features/scoring/*),
// tables and columns (obligation_objects.next_step_date); a citation is a claim about the tree, so it is checked against the tree. Two kinds are read, and only two: a repo path (with an optional `:line` or `:a-b` range
// that must lie inside the file) and `table.column` where the first part is a table or view of the database catalog (the schema reader is columns.mjs's loadSchema, tests/_support/schema.json being the live
// definition after schema.sql and every migration). Skipped by design: a glob or placeholder (the path grammar cannot contain `*`, `<`, `>`), the old tree (`fsi-app/`, `old_repo/` never start a match), a bare table
// name in a sentence (too noisy), and any `x.y` whose first part is not a table. Path existence is case-exact, so a citation that passes on Windows does not fail on the Linux runner. No credentials: file reads only.
// `node scripts/ci/verify-citations.mjs [--root R] [--docs P]... [--schema catalog.json] [--allow file] [--json]`; the vault repository runs it with --root pointing at this tree and --docs at its briefs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { isMain, posix, walk } from "../lib/fs.mjs";

import { loadSchema } from "./columns.mjs";

const EXT = "ts|tsx|mjs|cjs|js|json|sql|md|css|yml|yaml";
const PATH_RE = new RegExp(String.raw`(?:^|[\s(\x60"'])((?:src|scripts|supabase|tests|docs|\.claude|public|app)/[A-Za-z0-9_./\-\[\]@]+\.(?:${EXT}))(?![A-Za-z0-9_])(?::(\d+)(?:-(\d+))?)?`, "g");
const COLUMN_RE = /(?<![\w/.@-])([a-z][a-z0-9_]{2,})\.([a-z][a-z0-9_]{1,})\b(?!\()/g;
const FILE_EXT = new Set(EXT.split("|"));
const DEFAULT_DOCS = ["docs", ".claude", "README.md"];

const eachLine = (text, re, row) => text.split("\n").flatMap((line, i) => [...line.matchAll(re)].map((m) => row(m, i + 1)));

/** Every repo path a text cites: `{ path, lineStart?, lineEnd?, docLine }`. */
export const extractPathCitations = (text) =>
  eachLine(text, PATH_RE, (m, docLine) => ({ path: m[1], ...(m[2] ? { lineStart: Number(m[2]) } : {}), ...(m[3] ? { lineEnd: Number(m[3]) } : {}), docLine }));

/** Every `a.b` shaped token that is not a file name: `{ table, column, docLine }`. Whether `table` is a table is for verify to say. */
export const extractColumnCitations = (text) =>
  eachLine(text, COLUMN_RE, (m, docLine) => ({ table: m[1], column: m[2], docLine })).filter((c) => !FILE_EXT.has(c.column));

/** The allow file: `{ entries: [{ text, reason }] }`, every entry with a reason; returns the texts. */
export function loadAllow(file) {
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")).entries ?? []).map((e) => {
    if (!e.text || !e.reason) throw new Error(`${file}: every allow entry needs a text and a reason`);
    return e.text;
  });
}

/** `files` are document paths; `schema` is loadSchema().tables (Map table -> Set of columns); `allow` lists exact citation texts to ignore. */
export function verify({ files, root = ".", schema, allow = [] }) {
  const allowed = new Set(allow);
  const failures = [];
  const checked = { paths: 0, columns: 0 };
  const dirs = new Map();
  const lineCounts = new Map();
  const listing = (dir) => dirs.get(dir) ?? dirs.set(dir, statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? new Set(readdirSync(dir)) : new Set()).get(dir);
  const fileAt = (rel) => {
    let cur = root;
    for (const part of rel.split("/")) {
      if (!listing(cur).has(part)) return null;
      cur = join(cur, part);
    }
    return statSync(cur).isFile() ? cur : null;
  };
  const linesOf = (abs) => {
    if (!lineCounts.has(abs)) lineCounts.set(abs, readFileSync(abs, "utf8").replace(/\n$/, "").split("\n").length);
    return lineCounts.get(abs);
  };
  const shown = (doc) => (posix(relative(root, doc)).startsWith("../") ? posix(doc) : posix(relative(root, doc)));
  for (const doc of files) {
    const text = readFileSync(doc, "utf8");
    const fail = (docLine, kind, cited, reason) => failures.push({ doc: shown(doc), docLine, kind, text: cited, reason });
    for (const c of extractPathCitations(text)) {
      if (allowed.has(c.path)) continue;
      checked.paths += 1;
      const abs = fileAt(c.path);
      const cited = c.lineStart ? `${c.path}:${c.lineStart}${c.lineEnd ? `-${c.lineEnd}` : ""}` : c.path;
      if (!abs) fail(c.docLine, "path", cited, "no such file under the repo root");
      else if (c.lineStart && (c.lineStart < 1 || Math.max(c.lineStart, c.lineEnd ?? 0) > linesOf(abs) || (c.lineEnd && c.lineEnd < c.lineStart)))
        fail(c.docLine, "path", cited, `the line range is outside the file (${linesOf(abs)} lines)`);
    }
    for (const c of extractColumnCitations(text)) {
      const columns = schema.get(c.table);
      const cited = `${c.table}.${c.column}`;
      if (!columns || allowed.has(cited)) continue;
      checked.columns += 1;
      if (!columns.has(c.column)) fail(c.docLine, "column", cited, `table "${c.table}" has no column "${c.column}"`);
    }
  }
  return { failures, checked };
}

/** The markdown files under the document paths; a default path that does not exist is skipped, a named one that does not is an error. */
function docFiles(paths, explicit) {
  return paths.flatMap((p) => {
    const info = statSync(p, { throwIfNoEntry: false });
    if (!info) {
      if (explicit) throw new Error(`--docs ${p}: no such file or directory`);
      return [];
    }
    return info.isDirectory() ? walk(p, (n) => n.endsWith(".md")) : [posix(p)];
  });
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: "string", default: "." }, docs: { type: "string", multiple: true }, schema: { type: "string", default: "tests/_support/schema.json" }, allow: { type: "string", default: "scripts/ci/data/citation-allow.json" }, json: { type: "boolean", default: false } } });
  const root = resolve(values.root);
  const files = docFiles(values.docs ?? DEFAULT_DOCS.map((d) => join(root, d)), Boolean(values.docs));
  if (!files.length) throw new Error("citations: no document was found to read (a check that read nothing certifies nothing)");
  const result = verify({ files, root, schema: loadSchema({ catalog: join(root, values.schema), sqlFiles: [] }).tables, allow: loadAllow(join(root, values.allow)) });
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const f of result.failures) console.error(`${f.doc}:${f.docLine}  ${f.kind}  ${f.text}  ${f.reason}`);
    console.log(`citations: ${result.checked.paths} paths, ${result.checked.columns} columns checked, ${result.failures.length} failures`);
  }
  process.exit(result.failures.length ? 1 : 0);
}
