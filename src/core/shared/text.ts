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

/** kebab-case ascii slug, at most `max` characters. */
export function slugify(name: string, max = 40): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}
