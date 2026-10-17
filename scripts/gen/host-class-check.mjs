// The class vocabulary of host_verdicts (migration 0042) generated from the class table: a verdict names a class the institution class table carries, so the CHECK on the column is the table's own class names (IMP-054).
// scripts/ci/checks/generator-pins.mjs compares this text with the applied constraint on every schema run, so a class added to or removed from src/core/sources/data/tier-contract.json without a migration fails CI.
import { readFileSync } from "node:fs";

export const classNames = (path = "src/core/sources/data/tier-contract.json") => Object.keys(JSON.parse(readFileSync(path, "utf8")).classTier).sort();

/** The constraint, as a column-level fragment of a CREATE TABLE: CONSTRAINT host_verdicts_class_check CHECK (class IN (...)). */
export const renderHostClassCheck = (classes = classNames()) => `CONSTRAINT host_verdicts_class_check CHECK (class IN (${classes.map((c) => `'${c}'`).join(", ")}))`;
