import keys from "./schema-keys.json";

/** Primary-key columns per table, generated from supabase/schema.sql by scripts/gen/schema-keys.mjs. */
export const SCHEMA_KEYS = keys;
export type SchemaKeys = typeof keys;
export type TableName = keyof SchemaKeys;
