import assert from 'node:assert/strict';
import test from 'node:test';

import { splitStatements } from '../../scripts/ci/sql-split.mjs';

test('splits on semicolons outside quotes, comments, dollar quotes and parentheses', () => {
  const BS = String.fromCharCode(92);
  const sql = `-- header; not a statement\nSELECT 'a;b';\n/* x; y */ DO $f$ BEGIN PERFORM 1; END $f$;\nCREATE RULE r AS ON INSERT TO t DO ALSO (SELECT 1; SELECT 2);\nSELECT E'it${BS}'s;';`;
  const parts = splitStatements(sql);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.map((p) => p.line), [2, 3, 4, 5]);
  assert.match(parts[1].sql, /^DO \$f\$ BEGIN PERFORM 1; END \$f\$$/);
});

test('a trailing statement without a semicolon is kept and an empty tail is not', () => {
  assert.equal(splitStatements('SELECT 1;\nSELECT 2').length, 2);
  assert.equal(splitStatements('SELECT 1;\n-- done\n').length, 1);
});
