// The mutation behind the registry entry `selfcheck:*`: remove the change a migration makes and keep its self-check. Every statement that changes the database (DDL, DML, grants, comments, and the DO blocks that do the
// change) goes; what stays is the last DO block (the self-check, by the structure rule of scripts/ci/migration-checks.mjs) and the statements that only set it up (a temporary table, a SET). The self-check, run on the database
// as it was before the file, must raise: the change it asserts is not there. A file that changes nothing has nothing to remove, and the function returns null: such a file needs its own transform (see 0060 and 0062).
import { changesDatabase, isDoBlock, lastDoIndex, statementsOf } from "../../../scripts/ci/schema/statements.mjs";

export function mutate(text) {
  const statements = statementsOf(text);
  const keep = lastDoIndex(statements);
  if (keep < 0) return null;
  const removable = statements.filter((s, i) => i !== keep && (changesDatabase(s) || isDoBlock(s)));
  if (removable.length === 0) return null;
  return statements.filter((s, i) => i === keep || !removable.includes(s)).map((s) => `${s};`).join("\n");
}
