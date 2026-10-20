// INV-R2d-2 / S3: ONE admissible-row predicate, exported as `admissibleRows` (.itemIds, .claims) from src/core/derived/admissible.ts, with a SQL twin (item_is_admissible, the view admissible_claims).
// R2b's stand-in (src/core/briefs/admissible.ts) is gone and the theme-brief seam points at this module. Every case is the register's wrong outcome first, then the right one.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { admissibleRows, isAdmissibleItem } from "@/core/derived/admissible";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const U = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LIVE = U(1);
const ARCH = U(2);
const MOVED = U(3);
const RAW = U(4);
const item = (id: string, over: Row = {}): Row => ({ id, title: `Item ${id.slice(-2)}`, domain: 1, provenance_status: "verified", is_archived: false, replaced_by: null, ...over });
const items = (): Row[] => [item(LIVE), item(ARCH, { is_archived: true }), item(MOVED, { replaced_by: LIVE }), item(RAW, { provenance_status: "unverified" })];
const claim = (id: string, itemId: string, text: string): Row => ({ id, intelligence_item_id: itemId, claim_text: text, claim_kind: "FACT" });
const supp = (over: Row): Row => ({ id: `s-${String(over.target_ref)}-${String(over.created_at)}`, item_id: LIVE, target_kind: "fact", op: "suppress", machine_value: null, created_at: "2026-10-01T00:00:00Z", revoked_at: null, ...over });

test("admissibleRows.itemIds keeps the verified, unarchived, unreplaced items and nothing else: the register's readers drew the other three", async () => {
  const db = memoryDb({ intelligence_items: items() }).db;
  assert.deepEqual([...(await admissibleRows.itemIds(db, [LIVE, ARCH, MOVED, RAW, U(99)]))], [LIVE]);
  assert.deepEqual([...(await admissibleRows.itemIds(db, []))], []);
  assert.equal(isAdmissibleItem({ provenance_status: "verified", is_archived: false, replaced_by: null }), true);
  assert.equal(isAdmissibleItem({ provenance_status: "verified", is_archived: false }), false, "a column the reader did not read is not a pass");
  await assert.rejects(admissibleRows.itemIds(memoryDb({ intelligence_items: items() }, { failures: [{ table: "intelligence_items", op: "select", message: "down" }] }).db, [LIVE]), /admissible items read failed: down/, "a failed read throws, it is never an empty answer");
});

test("admissibleRows.claims drops the claims of an inadmissible item and the claims a suppression covers, by id first and then by the machine text, and a later replace or a revoked suppression restores a claim", async () => {
  const db = memoryDb({
    intelligence_items: [...items(), item(U(5))],
    fact_suppressions: [
      supp({ target_ref: "c-id" }),
      supp({ target_ref: "ref-text", machine_value: { claim_text: "suppressed by its text" } }),
      supp({ target_ref: "c-back", created_at: "2026-10-01T00:00:00Z" }),
      supp({ target_ref: "c-back", op: "replace", created_at: "2026-10-02T00:00:00Z" }),
      supp({ target_ref: "c-rev", revoked_at: "2026-10-03T00:00:00Z" }),
    ],
  }).db;
  const rows = [
    claim("c-ok", LIVE, "stands"), claim("c-id", LIVE, "suppressed by its id"), claim("c-text", LIVE, "suppressed by its text"), claim("c-back", LIVE, "restored by a later replace"), claim("c-rev", LIVE, "suppression revoked"),
    claim("c-other", U(5), "suppressed by its text"), claim("c-arch", ARCH, "of an archived item"), claim("c-moved", MOVED, "of a replaced item"), claim("c-raw", RAW, "of an unverified item"),
  ];
  const kept = (await admissibleRows.claims(db, rows as never)).map((r) => (r as { id: string }).id);
  assert.deepEqual(kept.sort(), ["c-back", "c-ok", "c-other", "c-rev"].sort(), "another item's claim with the same text is not covered by this item's suppression");
  await assert.rejects(admissibleRows.claims(memoryDb({ intelligence_items: items(), fact_suppressions: [] }, { failures: [{ table: "fact_suppressions", op: "select", message: "down" }] }).db, [claim("c-ok", LIVE, "x")] as never), /fact_suppressions read failed: down/, "a failed suppression read throws: a claim is never shown because the suppressions could not be read");
});

test("S3: R2b's local stand-in is deleted and the theme-brief seam points at the one predicate", () => {
  assert.equal(existsSync("src/core/briefs/admissible.ts"), false);
  assert.match(readFileSync("src/core/briefs/theme-brief-material.ts", "utf8"), /themeBriefSeams: ThemeBriefSeams = { comparator: figureCoverage, admissible: admissibleRows }/, "the theme brief reads the one predicate");
});

test("the SQL twin of the claim rule (migration 0093) says what the TypeScript says: admissible items only, suppressions read through fact_suppressions, an id match before a text match, the newest correction deciding, a revoked one ignored", () => {
  const sql = readFileSync("supabase/migrations/0093_admissible_claims.sql", "utf8");
  assert.match(sql, /JOIN public\.intelligence_items i ON i\.id = c\.intelligence_item_id AND public\.item_is_admissible\(i\.provenance_status, i\.is_archived, i\.replaced_by\)/);
  assert.match(sql, /FROM public\.fact_suppressions f/);
  assert.match(sql, /f\.revoked_at IS NULL/);
  assert.match(sql, /DISTINCT ON \(f\.target_ref\)[\s\S]*ORDER BY f\.target_ref, f\.created_at DESC, f\.id DESC/);
  assert.match(sql, /ORDER BY \(d\.target_ref = c\.id::text\) DESC, d\.created_at DESC, d\.id DESC/);
  assert.match(sql, /d\.machine_value ->> 'claim_text' = c\.claim_text/);
  for (const cell of ["by id", "by text", "restored", "revoked", "archived item", "replaced item", "unverified item"]) assert.ok(sql.includes(`' ${cell}'`), `the self-check plants a claim ${cell}`);
});
