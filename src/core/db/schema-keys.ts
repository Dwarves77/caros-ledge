import keys from "./schema-keys.json";

export type SchemaKeys = typeof keys;
export type TableName = keyof SchemaKeys;
