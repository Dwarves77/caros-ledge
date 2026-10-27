// The brief validator's report (VALID-1, INV-VAL-5): every registered rule over a set of (brief, item) pairs. For each rule it prints the briefs the rule applied to, the briefs it flagged, and the register's count beside it.
//   node scripts/ci/validator-report.mjs --fixture   the CI mode: tests/fixtures/validator-report/rows.ts, each row labelled with the rules it must trip; exits 1 when a row trips another set or a rule trips on no row
//   node scripts/ci/validator-report.mjs --live      read-only: the 535 live old-tree briefs through DATABASE_URL in a read-only transaction (stored sections and claims adapted to the rules' model); never wired into CI
// Live columns: `rule` is the rule as registered (prose view); `repro` is the rule's predicate in the form the register counted it (the whole body, or the register's own variant where it differs); `register` is the register's count; `diff` is repro minus register.
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";

register("./../lib/ts-hooks.mjs", import.meta.url, { data: {} });

const { values } = parseArgs({ options: { fixture: { type: "boolean", default: false }, live: { type: "boolean", default: false } } });
if (values.fixture === values.live) {
  console.error("usage: node scripts/ci/validator-report.mjs (--fixture | --live)");
  process.exit(1);
}
const { namesLacking, REGISTRY, runRule } = await import("../../src/core/brief/rules/index.ts");
const { ACCOUNTING_RE, LABELS, LABEL_OF, patternsOf, REGISTER_RENDERINGS, severityToken, stated } = await import("../../src/core/brief/validate.ts");
const { isVerbatim } = await import("../../src/core/contracts/verbatim.ts");

const REGISTER = JSON.parse(readFileSync(new URL("./data/validator-register.json", import.meta.url), "utf8")).counts;
const strip = (t) => t.replace(/"[^"\n]*"/g, "").replace(/“[^”\n]*”/g, "");
const BANNER = new RegExp(LABELS.join("|"));
/** The register's own predicate where it differs from the rule (one boolean, or one per register count). Every other rule is reproduced by itself over the whole body. */
const REPRO = {
  "dash-outside-verbatim": (b) => /[—–]/.test(strip(b.body)),
  "stored-date-stated": (b, i) => [i.entry_into_force, i.compliance_deadline].map((d) => !!d && !stated(b.body, d, REGISTER_RENDERINGS)),
  "fact-span-in-own-section": (b) => b.claims.some((c) => c.kind === "FACT" && c.section && c.span?.trim() && !isVerbatim(b.sections.get(c.section), c.span)),
  "accounting-line-present": (b) => !ACCOUNTING_RE.test(b.body),
  "no-claim-ledger-json": (b) => patternsOf("claim-ledger")[0].test(b.body),
  "banner-matches-column": (b, i) => {
    const m = BANNER.exec(b.body.slice(0, 600));
    return !!m && (i.severity === null || LABEL_OF[i.severity] !== m[0]);
  },
  "pool-or-slot-narration": (b) => patternsOf("pool-slot").map((r) => r.test(b.body)),
  "summary-fields-non-blank": (_b, i) => [!i.why_matters?.trim(), !i.what_is_it?.trim()],
  "structural-controls": (b) => patternsOf("structural").map((r) => r.test(b.body)),
};
const add = (into, v) => [v].flat().forEach((x, k) => (into[k] = (into[k] ?? 0) + (x ? 1 : 0)));
const show = (v) => [v].flat().join("/");

/** Tally every rule over the pairs (an async iterable of { brief, item, label }). Returns one row per registered rule. */
async function tally(pairs) {
  const rows = REGISTRY.map((r) => ({ id: r.id, applied: 0, rule: 0, repro: [], tripped: new Set() }));
  for await (const { brief, item, label } of pairs) {
    for (const [k, r] of REGISTRY.entries()) {
      if (!r.applies_to.includes(brief.format)) continue;
      const row = rows[k];
      row.applied += 1;
      if (runRule(r, brief, item)) {
        row.rule += 1;
        row.tripped.add(label);
      }
      add(row.repro, REPRO[r.id] ? REPRO[r.id](brief, item) : !!runRule(r, brief, item, true));
    }
  }
  return rows;
}

async function fixture() {
  const { ROWS } = await import("../../tests/fixtures/validator-report/rows.ts");
  const rows = await tally((async function* () { for (const r of ROWS) yield { brief: r.brief, item: r.item, label: r.id }; })());
  let bad = 0;
  for (const row of rows) {
    const want = new Set(ROWS.filter((r) => r.trips.includes(row.id)).map((r) => r.id));
    const wrong = [...row.tripped].filter((l) => !want.has(l)).concat([...want].filter((l) => !row.tripped.has(l)));
    console.log(`${row.id.padEnd(34)} applied ${String(row.applied).padStart(3)}  tripped ${row.tripped.size}  labelled ${want.size}${wrong.length ? `  MISMATCH on ${wrong.join(", ")}` : ""}${want.size === 0 ? "  NO FIXTURE ROW TRIPS THIS RULE" : ""}`);
    bad += wrong.length + (want.size === 0 ? 1 : 0);
  }
  console.log(`validator-report --fixture: ${ROWS.length} rows, ${rows.length} rules, ${bad} problem(s)`);
  process.exitCode = bad ? 1 : 0;
}

async function* livePairs(c) {
  const q = async (sql, p) => (await c.query(sql, p)).rows;
  const items = await q("select id, format_type, severity, priority, urgency_tier, entry_into_force::text as entry_into_force, compliance_deadline::text as compliance_deadline, what_it_changes, what_is_it, why_matters, topic_tags, sources_used, signal_band, theme, full_brief from public.intelligence_items where item_grade = 'brief' and not is_archived order by id");
  for (let at = 0; at < items.length; at += 20) {
    const chunk = items.slice(at, at + 20);
    const ids = chunk.map((i) => i.id);
    const sections = await q("select id, item_id, section_key, content_md from public.intelligence_item_sections where item_id = any($1)", [ids]);
    const claims = await q("select intelligence_item_id as item_id, section_row_id, claim_kind, claim_text, source_span, search_result_id from public.section_claim_provenance where intelligence_item_id = any($1)", [ids]);
    const wanted = [...new Set(claims.filter((k) => k.claim_kind === "FACT" && k.search_result_id).map((k) => k.search_result_id))];
    const captures = new Map((await q("select id, result_content from public.agent_run_searches where id = any($1)", [wanted])).map((r) => [r.id, r.result_content]));
    for (const it of chunk) {
      const own = sections.filter((s) => s.item_id === it.id);
      const keyOf = new Map(own.map((s) => [s.id, s.section_key]));
      const body = it.full_brief ?? "";
      // Stored quotes are ASCII or curly marks on a FACT line: the quoted run is the span (the new tree marks spans with guillemets).
      const exempt = body.split("\n").filter((l) => /^\s*(?:[-*]\s+)?FACT:/.test(l)).flatMap((l) => [...l.matchAll(/"([^"\n]*)"|“([^”\n]*)”/g)].map((m) => m[1] ?? m[2] ?? ""));
      const brief = {
        body, format: it.format_type, sections: new Map(own.map((s) => [s.section_key, s.content_md])), exempt,
        claims: claims.filter((k) => k.item_id === it.id).map((k) => ({ kind: k.claim_kind, section: keyOf.get(k.section_row_id) ?? "", span: k.source_span, text: k.claim_text, capture: captures.get(k.search_result_id) ?? null })),
      };
      const item = {
        severity: severityToken(it.severity), priority: it.priority, urgency_tier: it.urgency_tier, entry_into_force: it.entry_into_force, compliance_deadline: it.compliance_deadline,
        what_it_changes: it.what_it_changes, what_is_it: it.what_is_it, why_matters: it.why_matters, topic_tags: it.topic_tags ?? [], sources_used: it.sources_used ?? [],
        signal_band: it.signal_band, theme: it.theme, format_type: it.format_type, pool_chars: null, has_trajectory: false,
      };
      yield { brief, item, label: it.id };
    }
  }
}

async function live() {
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("set default_transaction_read_only = on");
    const orgs = (await c.query("select name from public.organizations")).rows;
    const lacking = namesLacking(orgs.map((o) => o.name));
    if (lacking.length) throw new Error(`organizations.name holds ${lacking.length} name part(s) whose hash data/workspace-names.json lacks (${lacking.join(", ")})`);
    const rows = await tally(livePairs(c));
    let off = 0;
    console.log("rule".padEnd(34), "applied".padStart(7), "rule".padStart(5), "repro".padStart(10), "register".padStart(10), "diff");
    for (const r of rows) {
      const diff = [REGISTER[r.id]].flat().map((w, k) => (r.repro[k] ?? 0) - w);
      off += diff.filter(Boolean).length;
      console.log(r.id.padEnd(34), String(r.applied).padStart(7), String(r.rule).padStart(5), show(r.repro.length ? r.repro : 0).padStart(10), show(REGISTER[r.id]).padStart(10), show(diff));
    }
    console.log(`validator-report --live: ${rows.length} rules, ${off} count(s) differ from the register`);
  } finally {
    await c.end();
  }
}

await (values.fixture ? fixture() : live());
