// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 441-547)
// The one flat-frontmatter block: `key: value` lines, a scalar, an inline `[a, b]` array of plain strings, or inline JSON. `buildFrontmatter` refuses what the line format cannot carry (a newline, a comma inside an inline-array
// item, a scalar that starts and ends with the same quote, which a reader would strip); `parseFrontmatter` is its inverse and the only reader of a markdown batch container. No wall clock is read here.
export type FrontmatterValue = string | null | readonly string[] | { readonly json: unknown };
export type Frontmatter = Record<string, string | string[] | unknown>;

const scalar = (v: string | null, name: string): string => {
  if (v === null) return "null";
  if (/\r|\n/.test(v)) throw new Error(`${name} contains a newline, which a flat frontmatter block cannot represent`);
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) throw new Error(`${name} starts and ends with a matching quote character, which a reader would strip as a quoted literal`);
  return t;
};
const inlineArray = (items: readonly string[], name: string): string => {
  for (const item of items) {
    if (typeof item !== "string") throw new Error(`${name} contains a non-string entry: ${JSON.stringify(item)}`);
    if (item.includes(",")) throw new Error(`${name} entry ${JSON.stringify(item)} contains a comma, which an inline array cannot represent (a reader splits on ",")`);
    if (/\r|\n/.test(item)) throw new Error(`${name} entry ${JSON.stringify(item)} contains a newline`);
  }
  return `[${items.join(", ")}]`;
};

/** The frontmatter lines for `fields`, in the given order, wrapped in `---` fences. Throws a plain Error naming the field that cannot be represented. */
export function buildFrontmatter(fields: Readonly<Record<string, FrontmatterValue>>): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? inlineArray(v, k) : v !== null && typeof v === "object" ? JSON.stringify((v as { json: unknown }).json) : scalar(v as string | null, k)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** A markdown text that starts with a frontmatter block: its fields (a scalar stays a string, `[a, b]` an array, `{...}` parsed JSON, `null` null) and the body after the closing fence; null when there is no block. */
export function parseFrontmatter(text: string): { fields: Frontmatter; body: string } | null {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fields: Frontmatter = {};
  for (const line of (m[1] as string).split("\n")) {
    const kv = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const raw = (kv[2] as string).trim();
    if (raw === "null") fields[kv[1] as string] = null;
    else if (raw.startsWith("[") && raw.endsWith("]") && !raw.startsWith("[{")) fields[kv[1] as string] = raw.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    else if (raw.startsWith("{") || raw.startsWith("[")) {
      try {
        fields[kv[1] as string] = JSON.parse(raw) as unknown;
      } catch {
        fields[kv[1] as string] = raw;
      }
    } else fields[kv[1] as string] = raw.replace(/^["']|["']$/g, "");
  }
  return { fields, body: (m[2] as string).trim() };
}
