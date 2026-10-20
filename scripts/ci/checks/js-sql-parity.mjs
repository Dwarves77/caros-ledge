// JavaScript and SQL give one answer (R2f INV-R2f-2 and INV-R2f-4). The verbatim rule is isVerbatim in src/core/contracts/verbatim.ts and public.is_verbatim in the database (migration 0106, rendered from the same constants); the citation
// URL canonical form is canonicalizeUrl in src/core/parse and public.canonicalize_citation_url (migration 0107, rendered from the same data). Three things are checked: the applied functions ARE what the JavaScript renders (each is
// re-created from the generated text in a transaction that rolls back, and its definition must not change); each fixture row carries the answer BOTH must give (scripts/ci/fixtures): the 40 (capture, span) pairs include a no-break space,
// a narrow no-break space digit group, a soft hyphen, curly quotes, a tab and an astral character; the URL rows never lower-case a path or a query, and every tracking parameter of the parse data is added. The JavaScript functions are
// run on the same rows, so a fixture row neither side agrees with is named. Run by scripts/ci/schema-apply.mjs after the migrations (through tests/_support/register.mjs, which resolves "@/").
// Exit 1 on a difference or a missing DATABASE_URL where the event could carry one; exit 2 only where nothing was promised (src/core/harness/exit.ts).
import { readFileSync } from "node:fs";

import { psql } from "../psql.mjs";

const url = process.env.DATABASE_URL;
const { skipVerdict } = await import("@/core/harness/exit");
const verdict = skipVerdict(process.env, url ? [] : ["DATABASE_URL"]);
if (verdict.message) {
  console.error(`js-sql-parity: ${verdict.message}`);
  process.exit(verdict.exit);
}
const { isVerbatim, renderVerbatimSql } = await import("@/core/contracts");
const { canonicalUrl } = await import("@/core/shared");
const { TRACKING_PARAMS, renderCanonicalizeUrlSql } = await import("@/core/parse");

const hex = (s) => `convert_from(decode('${Buffer.from(String(s), "utf8").toString("hex")}', 'hex'), 'UTF8')`;
const run = (sql) => {
  const r = psql(url, { sql: `BEGIN;\n${sql}\nROLLBACK;\n`, tuples: true, sep: "\t" });
  if (r.status !== 0) throw new Error(`js-sql-parity: SQL failed\n${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean);
};
/** One answer per select, in order. */
const ask = (selects) => run(`${selects.map((s, i) => `SELECT ${i}, ${s}`).join("\nUNION ALL ")}\nORDER BY 1;`).map((l) => l.split("\t").slice(1).join("\t"));

/** The applied functions are exactly what the JavaScript renders: re-create each from the generated text and its definition (line ends aside) must not change. */
function renderedMismatches(functions, generated) {
  const defs = (tag) => functions.map((f) => `SELECT '${tag} ${f}', md5(replace(pg_get_functiondef('${f}'::regprocedure), E'\\r', ''))`).join("\nUNION ALL ");
  const md5 = new Map(run(`${defs("before")};\n${generated}\n${defs("after")};`).map((l) => l.split("\t")));
  return functions.filter((f) => md5.get(`before ${f}`) !== md5.get(`after ${f}`)).map((f) => `${f}: the applied definition differs from the one the JavaScript renders`);
}

const problems = renderedMismatches(["public.is_verbatim(text, text)"], renderVerbatimSql());
const pairs = JSON.parse(readFileSync("scripts/ci/fixtures/verbatim-spans.json", "utf8")).pairs;
const sqlVerdicts = ask(pairs.map((p) => `public.is_verbatim(${hex(p.capture)}, ${hex(p.span)})::text`));
pairs.forEach((p, i) => {
  const js = isVerbatim(p.capture, p.span);
  const sql = sqlVerdicts[i] === "true";
  if (js !== p.verbatim || sql !== p.verbatim) problems.push(`verbatim "${p.name}": fixture says ${p.verbatim}, isVerbatim says ${js}, is_verbatim says ${sql}`);
});
console.log(`${problems.length ? "FAIL" : "PASS"} js-sql-parity verbatim: ${pairs.length} spans through isVerbatim and public.is_verbatim, and the applied function is the rendered one`);

const rows = JSON.parse(readFileSync("scripts/ci/fixtures/canonical-urls.json", "utf8")).urls;
const tracking = TRACKING_PARAMS.map((p) => ({ url: `https://example.com/Doc?Keep=1&${p}=zzz&${p.toUpperCase()}=yyy`, canonical: "https://example.com/Doc?Keep=1" }));
const all = [...rows, ...tracking];
const before = problems.length;
problems.push(...renderedMismatches(["public.canonical_form_decode(text)", "public.canonical_form_encode(text)", "public.canonicalize_citation_url(text)"], renderCanonicalizeUrlSql()));
const sqlUrls = ask(all.map((r) => `coalesce(public.canonicalize_citation_url(${hex(r.url)}), '<null>')`));
all.forEach((r, i) => {
  const js = canonicalUrl(r.url);
  if (js !== r.canonical || sqlUrls[i] !== r.canonical) problems.push(`url ${JSON.stringify(r.url)}: fixture says ${JSON.stringify(r.canonical)}, canonicalUrl says ${JSON.stringify(js)}, canonicalize_citation_url says ${JSON.stringify(sqlUrls[i])}`);
});
console.log(`${problems.length > before ? "FAIL" : "PASS"} js-sql-parity urls: ${all.length} URLs through canonicalUrl and public.canonicalize_citation_url, and the applied functions are the rendered ones`);
for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
process.exit(problems.length ? 1 : 0);
