// Ported from old_repo/src/lib/text/html-to-text.mjs (lines 14-25)
// Ported from old_repo/src/app/api/community/groups/route.ts (lines 16-23)

/** JSON.parse that answers null for text that is not JSON: the caller states what a non-JSON body means. */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Strip scripts, styles and tags to plain text; entities are kept unless `blankEntities`. */
export function htmlToText(html: unknown, opts: { maxChars?: number; blankEntities?: boolean } = {}): string {
  const text = String(html ?? "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:[a-z]+|#\d+);/gi, (m) => (opts.blankEntities ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
  return typeof opts.maxChars === "number" ? text.slice(0, opts.maxChars) : text;
}

/** kebab-case ascii slug, at most `max` characters. */
export function slugify(name: string, max = 40): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}
