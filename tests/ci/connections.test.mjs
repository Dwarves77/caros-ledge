import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("scripts/ci/connections.mjs");

/** A minimal tree: one root file under src/core/turn, one runtime entry, and the three data files the check reads. */
function tree(rootBody) {
  const dir = mkdtempSync(join(tmpdir(), "conn-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("scripts/ci/connections-allow.json", '{ "entries": {}, "written": [] }');
  put("src/core/harness/data/families.json", "[]");
  put("src/core/turn/registry.ts", "export const STAGES = [] as const;\n");
  put("src/features/x/run.ts", 'import type { RunResult } from "@/core/types/run-result";\nexport async function runX(): Promise<RunResult> {\n  return { counts: {}, outcome: "ok", notes: [] };\n}\n');
  put("src/core/turn/root.ts", rootBody);
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}

test("a runtime that a root file names is called", () => {
  const r = tree('import { runX } from "@/features/x/run";\nexport const go = () => runX();\n');
  assert.equal(r.status, 0, r.stderr);
});

test("planted: a file that only imports a runtime does not call it, and the check is red", () => {
  const r = tree('import { runX } from "@/features/x/run";\nexport const unused = 1;\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runX is a runtime entry with no caller/);
});

test("planted: a multi-line import is not a call either", () => {
  const r = tree('import {\n  runX,\n} from "@/features/x/run";\nexport const unused = 1;\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runX is a runtime entry with no caller/);
});
