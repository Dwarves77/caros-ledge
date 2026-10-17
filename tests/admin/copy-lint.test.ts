import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

// PROP-076 / PROP-087: no admin copy asserts a human gate (the machine gates are the approval; the console observes and overrides after the fact).
// PROP-011/109 (the free build): no admin module reaches a paid or metered model.
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? files(`${dir}/${n}`) : /\.tsx?$/.test(n) ? [`${dir}/${n}`] : []));
const admin = [...files("src/features/admin"), ...files("src/features/coverage"), ...files("src/app/admin")];

export const FORBIDDEN_COPY: RegExp[] = [
  /\b(awaiting|requires?|needs?|pending|waiting (?:for|on))\s+(?:a\s+|an\s+)?(?:human|operator|manual|admin)\s+(?:review|approval|sign-?off|decision|confirmation)\b/i,
  /\bhuman[- ]gate\b/i,
  /\bmust be (?:approved|reviewed|signed off) by (?:a |an )?(?:human|person|operator|admin)\b/i,
  /\b(?:publish|go live) (?:after|once|when) (?:an? )?(?:human|operator|admin) (?:approves|reviews|signs)/i,
];
export const METERED_IMPORT = /from\s+["'](?:@anthropic-ai\/[^"']*|openai|@\/core\/(?:metered|llm|anthropic)[^"']*)["']/;

test("no admin or coverage copy asserts a human gate (PROP-076, PROP-087); the lint itself catches each forbidden phrase", () => {
  assert.ok(admin.length > 60, `scanned ${admin.length} files`);
  for (const f of admin) {
    const src = readFileSync(f, "utf8");
    for (const re of FORBIDDEN_COPY) assert.ok(!re.test(src), `${f} matches ${re}`);
  }
  for (const sample of ["Awaiting human review", "needs operator approval", "the human gate", "must be approved by an admin", "publish after a human approves"]) {
    assert.ok(FORBIDDEN_COPY.some((re) => re.test(sample)), `the lint misses: ${sample}`);
  }
});

test("no admin module imports a model client or a metered pass (the free build, PROP-011/109)", () => {
  for (const f of admin) assert.ok(!METERED_IMPORT.test(readFileSync(f, "utf8")), `${f} imports a metered client`);
  assert.ok(METERED_IMPORT.test('import x from "@anthropic-ai/sdk";'), "the lint catches an SDK import");
});
