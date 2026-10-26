// DRAIN-1: the turn CLI reads its stage input from --input (inline JSON) or --input-file (a path), never both. An argv string over ~128 KB cannot be spawned on Linux (E2BIG), so a large batch travels as a file.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { turnInputText } from "../../scripts/lib/turn-input.mjs";

const dir = mkdtempSync(join(tmpdir(), "turn-input-"));
const file = join(dir, "in.json");
writeFileSync(file, '{"briefs":{"batch":{"kind":"item-briefs","content":"x"}}}');

test("--input-file reads the file's text; --input alone is returned as given; neither is the empty object", () => {
  assert.equal(turnInputText({ "input-file": file }), '{"briefs":{"batch":{"kind":"item-briefs","content":"x"}}}');
  assert.equal(turnInputText({ input: '{"a":1}' }), '{"a":1}');
  assert.equal(turnInputText({}), "{}");
});

test("--input together with --input-file is refused, and an unreadable file is a refusal naming the path", () => {
  assert.throws(() => turnInputText({ input: "{}", "input-file": file }), /not both/);
  assert.throws(() => turnInputText({ "input-file": join(dir, "missing.json") }), /missing\.json/);
});

test("turn.mjs refuses --input with --input-file before it loads any source or credential (exit 1)", () => {
  const r = spawnSync(process.execPath, ["scripts/turn.mjs", "--stage", "briefs", "--mode", "dry", "--input", "{}", "--input-file", file], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not both/);
});
