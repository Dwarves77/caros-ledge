// Ported from old_repo/src/lib/sources/feed-walk.mjs (lines 7-18)
// Ported from old_repo/src/lib/sources/sitemap-walk.mjs (lines 23-29)
// Ported from old_repo/src/lib/sources/sitemap-walk.mjs (lines 167-171)

/** Text of an XML or HTML fragment: CDATA unwrapped, tags dropped, the five basic entities decoded, whitespace collapsed. */
export const strip = (s: unknown): string =>
  String(s ?? "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** The first inner text of `tag` within `block`, or null. */
export function inner(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? strip(m[1]) : null;
}
