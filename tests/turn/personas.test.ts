// The persona matrices (G12, W:5): every matrix names an expectation for every persona, and the organisation admin is a persona of its own, apart from the platform admin (W:4 lived in the gap between the two).
import assert from "node:assert/strict";
import { test } from "node:test";

import { expectationFor, PERSONAS, type Persona } from "../_support/personas.ts";

test("the personas include the organisation admin and the platform admin as two callers", () => {
  assert.ok(PERSONAS.includes("admin"));
  assert.ok(PERSONAS.includes("platformAdmin"));
  assert.equal(new Set(PERSONAS).size, PERSONAS.length);
});

test("planted: a matrix with no expectation for a persona fails by name instead of comparing with undefined; one with all of them reads each", () => {
  const all = Object.fromEntries(PERSONAS.map((p) => [p, 403])) as Record<Persona, number>;
  for (const p of PERSONAS) assert.equal(expectationFor(all, p, "m"), 403);
  const withoutAdmin = Object.fromEntries(Object.entries(all).filter(([persona]) => persona !== "admin")) as Partial<Record<Persona, number>>;
  assert.throws(() => expectationFor(withoutAdmin, "admin", "members PATCH"), /members PATCH: the matrix has no expectation for the persona "admin"/);
  assert.equal(expectationFor({ anon: 0 }, "anon", "zero is an expectation"), 0, "a falsy expectation is still one");
});
