// Ported from old_repo/src/lib/sources/feed-walk.mjs (lines 7-18)
// Ported from old_repo/src/lib/sources/sitemap-walk.mjs (lines 23-29)
// Ported from old_repo/src/lib/sources/sitemap-walk.mjs (lines 167-171)
import { decodeEntities, stripTags } from "@/core/fetch/entities";

/**
 * Text of an XML or HTML fragment: a CDATA section is literal (its markup is dropped, its ampersands are not decoded again), tags are dropped, and character references outside CDATA are decoded once by the one decoder
 * (R2c C7, register row D:87: the old chain decoded the ampersand first, so `&amp;lt;b&amp;gt;` came out as `<b>`). Whitespace is collapsed.
 */
export const strip = (s: unknown): string =>
  String(s ?? "")
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part) => (part.startsWith("<![CDATA[") ? stripTags(part.slice(9, -3)) : decodeEntities(stripTags(part))))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

/** The first inner text of `tag` within `block`, or null. */
export function inner(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? strip(m[1]) : null;
}
