import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("scripts/ci/connections.mjs");

/**
 * A minimal tree: a runtime entry (src/features/x/run.ts), the turn registry, a root file under src/core/turn that `rootBody` fills, a script that calls the root file's `go`, and the data files and directories
 * the check reads. The toy tree's own exports are named in the allow file so the only offender left is the one the test is about.
 */
function tree(rootBody, allowedExports = {}, mainBody = 'import { go } from "../src/core/turn/root.ts";\ngo();\n') {
  const dir = mkdtempSync(join(tmpdir(), "conn-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  for (const d of ["supabase/functions", "supabase/migrations", ".github/workflows"]) mkdirSync(join(dir, d), { recursive: true });
  put("tests/_support/schema.json", '{ "tables": {} }');
  put("scripts/ci/connections-allow.json", JSON.stringify({ _exports: "the toy tree exports what it exports", exports: { "src/core/turn/registry.ts": ["STAGES"], ...allowedExports } }));
  put("scripts/main.mjs", mainBody);
  put("src/core/harness/data/families.json", "[]");
  put("src/core/turn/registry.ts", "export const STAGES = [] as const;\n");
  put("src/features/x/run.ts", 'import type { RunResult } from "@/core/types/run-result";\nexport async function runX(): Promise<RunResult> {\n  return { counts: {}, outcome: "ok", notes: [] };\n}\n');
  put("src/core/turn/root.ts", rootBody);
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}

test("a runtime that a root file calls, and a script reaches, is called", () => {
  const r = tree('import { runX } from "@/features/x/run";\nexport const go = () => runX();\n');
  assert.equal(r.status, 0, r.stderr);
});

test("planted: a file that names a runtime only in a comment and a string does not call it, and the check is red", () => {
  const r = tree('import { runX } from "@/features/x/run";\n// runX runs here\nexport const go = () => "runX";\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runX is a runtime entry \(it returns a RunResult\) with no caller/);
});

test("planted: a multi-line import that is never used is not a call either", () => {
  const r = tree('import {\n  runX,\n} from "@/features/x/run";\nexport const go = () => 1;\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runX is a runtime entry \(it returns a RunResult\) with no caller/);
});


test("a dynamic import that destructures names uses those names and no others; an export it does not name stays uncalled", () => {
  const root = 'import { runX } from "@/features/x/run";\nexport const go = () => runX();\nexport const other = () => 2;\n';
  const used = tree(root, {}, 'const { go, other } = await import("../src/core/turn/root.ts");\ngo();\nother();\n');
  assert.equal(used.status, 0, used.stderr);
  const partly = tree(root, {}, 'const { go } = await import("../src/core/turn/root.ts");\ngo();\n');
  assert.equal(partly.status, 1);
  assert.match(partly.stderr, /root\.ts:3: other is an export with no caller/);
});
