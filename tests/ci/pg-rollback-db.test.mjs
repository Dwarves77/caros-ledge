// The SYNTH-APPLY-1 harness artifact: the rollback shim sent an empty array bound to a jsonb parameter as the pg text[] literal {}, which jsonb reads as an object ("cannot extract elements from an object").
import assert from "node:assert/strict";
import test from "node:test";

import { encodeRpcArgs } from "../../scripts/ops/pg-rollback-db.mjs";

test("an empty array bound to a jsonb parameter is JSON [], not a pg array", () => {
  assert.deepEqual(encodeRpcArgs({ p_inputs: [] }, { p_inputs: "jsonb" }), ["[]"]);
});
test("an array of scalars bound to a jsonb parameter is JSON text; one bound to a uuid[] or text[] stays an array", () => {
  assert.deepEqual(encodeRpcArgs({ a: ["x"], b: ["y"] }, { a: "jsonb" }), ['["x"]', ["y"]]);
});
test("untyped behaviour is unchanged: objects and arrays of objects are JSON, scalars and scalar arrays pass through", () => {
  assert.deepEqual(encodeRpcArgs({ o: { k: 1 }, l: [{ k: 1 }], s: "t", n: null, e: [] }), ['{"k":1}', '[{"k":1}]', "t", null, []]);
});
test("a null jsonb argument stays null", () => {
  assert.deepEqual(encodeRpcArgs({ p: null }, { p: "jsonb" }), [null]);
});
