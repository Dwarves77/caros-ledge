// The intake tests' stand-in is the one shared memory database (tests/_support/memdb.ts); this re-export keeps their import path.
export { MemDb } from "../_support/memdb.ts";
export type { MemCall, Row } from "../_support/memdb.ts";
