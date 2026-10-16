import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const SLICE_DIRS = ["src/core/brief", "src/core/grounding", "src/core/contracts", "src/core/intake", "src/features/intake", "src/app/api/agent"];
const slice = SLICE_DIRS.flatMap((d) => files(d)).filter((f) => /\.(ts|tsx|json)$/.test(f));
const code = slice.filter((f) => /\.tsx?$/.test(f));
const read = (f: string) => readFileSync(f, "utf8");
const hits = (re: RegExp, list = slice) => list.filter((f) => re.test(read(f)));

test("INV-169: nothing in this slice inserts into intelligence_items (the mint chokepoint is the only writer of new rows)", () => {
  const direct = /from\(\s*["'`]intelligence_items["'`]\s*\)[^;]{0,400}?\.\s*(insert|upsert)\s*\(/;
  const helper = /(insertMany|insert|upsert)\w*\(\s*\w+\s*,\s*["'`]intelligence_items["'`]/;
  assert.deepEqual(hits(direct, code), [], "no direct insert/upsert on intelligence_items");
  assert.deepEqual(hits(helper, code), [], "no helper insert on intelligence_items");
  // the writes this slice does make on the table are updates of an existing row, by id
  for (const f of hits(/from\(\s*["']intelligence_items["']\s*\)[^;]{0,200}\.update\(/, code)) assert.match(read(f), /\.eq\(\s*["']id["']/, `${f}: an update is by id`);
});

test("PROP-008/164 and PROP-042/145: no Anthropic client, no metered client and no model-id literal anywhere in the slice", () => {
  assert.deepEqual(hits(/@anthropic-ai|from\s+["']openai["']|api\.anthropic\.com|x-api-key|browserless/i), []);
  assert.deepEqual(hits(/claude-[a-z0-9.-]*(opus|sonnet|haiku)|claude-\d|\bgpt-\d|anthropic-version/i), [], "no model id literal");
  assert.deepEqual(hits(/ANTHROPIC_API_KEY|BROWSERLESS|OPENAI/), []);
  const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> };
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}).filter((d) => /anthropic|openai|browserless/i.test(d)), []);
});

test("WAVE-2 rules: no process.exit, no environment read, no schedule or cadence, no console, no wall clock outside deps.now", () => {
  assert.deepEqual(hits(/process\.exit|process\.env/, code), []);
  assert.deepEqual(hits(/\bsetInterval\b|\bcron\b|scrape_cadence|\bschedule\w*\(/i, code), [], "build mode: every runtime is dispatched, nothing is scheduled (rule 16)");
  assert.deepEqual(hits(/console\./, code), []);
  assert.deepEqual(hits(/new Date\(\)|Date\.now\(\)/, code), [], "the clock arrives through deps.now");
});

test("defects not to repeat: no 'recorded: true' result, no unchecked stamp, no file over 400 lines", () => {
  assert.deepEqual(hits(/recorded:\s*true/, code), []);
  for (const f of code) assert.ok(read(f).split("\n").length <= 400, `${f} is over 400 lines`);
});

test("every Supabase read in the slice destructures its error (B-0060 / B-0263 / B-0264 / B-0265 shape)", () => {
  // `const { data } = await sb.from(` with no error in the same destructure is the swallowed-error shape.
  const swallowed = /const\s*\{\s*(?:data|count)\s*\}\s*=\s*await\s+(?:sb|deps\.sb|this\.sb)\s*\.from\(/;
  assert.deepEqual(hits(swallowed, code), []);
  const bare = /^\s*await\s+(?:sb|deps\.sb)\s*\.from\([^;]*\.(?:insert|update|upsert|delete)\(/m;
  assert.deepEqual(hits(bare, code), [], "a write whose result is awaited and dropped");
});

test("every data file is parseable JSON and no data file carries the metered prompt wrapper", () => {
  for (const f of slice.filter((x) => x.endsWith(".json"))) {
    assert.doesNotThrow(() => JSON.parse(read(f)), f);
  }
  assert.deepEqual(hits(/export const SYSTEM_PROMPT/, slice.filter((x) => x.endsWith(".json"))), []);
});
