// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 441-547)
export type Frontmatter = Record<string, string | string[] | unknown>;


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
