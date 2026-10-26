import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { namesLacking, nameAt } from "@/core/brief/rules/_text";
import { tokenHash } from "@/core/contracts/token-hash";

import { fixtureRow, run, ruleTests } from "../_cases.ts";

ruleTests("workspace-or-client-named");

// The names are held only as hashes. The plant is a fictional name whose hash ships beside the real ones, so the match is proved through the hash and no test file holds a real name.
const PLANT = "Zorblax Quillfeather";

test("the match goes through the hash: a clear planted name is found case-insensitively, a word alone is not, and the data holds no clear name", () => {
  const data = JSON.parse(readFileSync("src/core/brief/data/workspace-names.json", "utf8")) as { hashes: string[] };
  assert.ok(data.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), "every entry is a SHA-256 hex digest");
  assert.ok(data.hashes.includes(tokenHash(PLANT)));
  assert.equal(nameAt(`Prefix text. ${PLANT.toUpperCase()} commissions crates.`), 13);
  assert.equal(nameAt("Zorblax alone, and Quillfeather alone, are not the name."), -1);
  assert.equal(nameAt("Zorblax and Quillfeather, a clause apart."), -1);
  const row = fixtureRow("workspace-or-client-named");
  assert.ok(row.brief.body.includes(PLANT));
  assert.equal(run("workspace-or-client-named", row.brief, row.item)?.rule, "workspace-or-client-named");
});

test("nameAt takes any hash set (a test plants its own), and tokenHash is the helper tree-checks uses for its banned token", () => {
  const mine = new Set([tokenHash("Frobnitz"), tokenHash("Ada Lovelace-Smith")]);
  assert.equal(nameAt("A note on Frobnitz.", mine), 10);
  assert.equal(nameAt("Ada Lovelace-Smith wrote it.", mine, 2), -1, "a hyphen splits the word: the hash is of whole words");
  assert.equal(tokenHash("ABC"), tokenHash("abc"));
  assert.match(readFileSync("scripts/ci/tree-checks.mjs", "utf8"), /tokenHash\(t\)/);
});

test("the live report's organization check names a part whose hash the list lacks, and nothing else", () => {
  const mine = new Set([tokenHash("Acme"), tokenHash("Globex")]);
  assert.deepEqual(namesLacking(["Acme / Globex"], mine), []);
  assert.deepEqual(namesLacking(["Acme / Initech"], mine), [tokenHash("Initech")]);
});
