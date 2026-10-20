// What a migration statement does, decided once for the static check (migration-checks.mjs: the self-check must come after the last change). A statement CHANGES the database when its first keyword is DDL or DML and it is not on a temporary table the file made for its own use.
import { splitStatements } from "../sql-split.mjs";

const CHANGES = new Set(["CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "INSERT", "UPDATE", "DELETE", "COMMENT", "TRUNCATE", "REINDEX", "REFRESH"]);

export const firstWord = (sql) => sql.replace(/^\(?\s*/, "").split(/\s+/)[0].toUpperCase();

/** A WITH statement whose body is an INSERT, UPDATE or DELETE: `WITH parts AS (...) UPDATE t SET ...` changes the database although it starts with WITH. */
const dataModifyingWith = (sql) => firstWord(sql) === "WITH" && /\)\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s/i.test(sql);

export function changesDatabase(sql) {
  if (dataModifyingWith(sql)) return true;
  if (!CHANGES.has(firstWord(sql))) return false;
  if (/^CREATE\s+(GLOBAL\s+|LOCAL\s+)?TEMP(ORARY)?\b/i.test(sql)) return false;
  if (/^(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+_\w+/i.test(sql)) return false; // a temporary table the file created for its own use
  return true;
}

export const statementsOf = (text) => splitStatements(text).map((s) => s.sql);
export const isDoBlock = (sql) => /^DO\b/i.test(sql);
/** The index of the last DO block, or -1. */
export const lastDoIndex = (statements) => statements.map((s, i) => (isDoBlock(s) ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1;
