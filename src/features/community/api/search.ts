// Ported from old_repo/src/app/api/community/search/route.ts (lines 29-177)
// Ported from old_repo/src/lib/community/search-merge.ts (lines 1-11)
// GET /api/community/search?q=&scope=: posts, groups and people. One `ilike` per column, unioned in code (CF-SEC-15: no composed `.or()` carrying user text), with the wildcards in the query escaped. A failed read is a
// 503 for the whole search, never an empty section. People come from the identity definer, which never matches a member whose name is withheld. A post hit carries its group and its id, so it links to the post.
import { HttpError, ok, route } from "@/core/http/errors";
import { isRefusal, requireUser } from "@/core/http/guard";

import { loadIdentities } from "../lib/identity";
import { LIMITS } from "../lib/labels";

import { many } from "./_http";

const SCOPES = ["all", "posts", "groups", "people"] as const;
const MIN_QUERY = 2;
const PER_SCOPE = 8;
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`);
const excerpt = (body: string, q: string): string => {
  const at = body.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return body.slice(0, 160).trim();
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "… " : ""}${body.slice(start, start + 160).trim()}${start + 160 < body.length ? " …" : ""}`;
};
/** The newest rows of several lists, one row per id, cut to `limit`. */
function unionByRecency<T extends { id: string }>(lists: ReadonlyArray<ReadonlyArray<T>>, key: keyof T, limit: number): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) for (const row of list) if (!seen.has(row.id)) seen.set(row.id, row);
  return [...seen.values()].sort((a, b) => String(b[key] ?? "").localeCompare(String(a[key] ?? ""))).slice(0, limit);
}

type PostHit = { id: string; title: string | null; body: string; group_id: string; created_at: string };
type GroupHit = { id: string; name: string; slug: string; region: string; privacy: "public" | "private"; member_count: number; last_active_at: string | null };

export const GET = route("/api/community/search", async (request) => {
  const auth = await requireUser(request);
  if (isRefusal(auth)) return auth;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, LIMITS.search);
  const scopeRaw = (url.searchParams.get("scope") ?? "all").toLowerCase();
  const scope = (SCOPES as readonly string[]).includes(scopeRaw) ? scopeRaw : "all";
  if (q.length < MIN_QUERY) return ok(auth.headers, { posts: [], groups: [], people: [] });
  const like = `%${escapeLike(q)}%`;
  const wants = (s: string) => scope === "all" || scope === s;
  const postsBy = (column: "title" | "body") => many<PostHit>(auth.client.from("community_posts").select("id, title, body, group_id, created_at").is("parent_post_id", null).ilike(column, like).order("created_at", { ascending: false }).order("id", { ascending: true }).limit(PER_SCOPE), `post search by ${column}`);
  const groupsBy = (column: "name" | "description") => many<GroupHit>(auth.client.from("community_groups").select("id, name, slug, region, privacy, member_count, last_active_at").ilike(column, like).order("last_active_at", { ascending: false }).order("id", { ascending: true }).limit(PER_SCOPE), `group search by ${column}`);
  const [byTitle, byBody, byName, byDescription, people] = await Promise.all([
    wants("posts") ? postsBy("title") : [],
    wants("posts") ? postsBy("body") : [],
    wants("groups") ? groupsBy("name") : [],
    wants("groups") ? groupsBy("description") : [],
    wants("people") ? loadIdentities(auth.client, null, q) : { rows: [], error: null },
  ]);
  if (people.error) throw new HttpError(503, "Searching for people is unavailable just now", { "Retry-After": "1" });
  const postRows = unionByRecency([byTitle, byBody], "created_at", PER_SCOPE);
  const groupRows = unionByRecency([byName, byDescription], "last_active_at", PER_SCOPE);
  const groupIds = [...new Set(postRows.map((p) => p.group_id))];
  const named = groupIds.length ? await many<{ id: string; name: string; slug: string }>(auth.client.from("community_groups").select("id, name, slug").in("id", groupIds), "post groups") : [];
  const groupById = new Map(named.map((g) => [g.id, g]));
  return ok(auth.headers, {
    posts: postRows.map((p) => ({ id: p.id, title: p.title ?? "Untitled thread", body_excerpt: excerpt(p.body, q), group_id: p.group_id, group_name: groupById.get(p.group_id)?.name ?? null, group_slug: groupById.get(p.group_id)?.slug ?? null, created_at: p.created_at })),
    groups: groupRows.map((g) => ({ id: g.id, name: g.name, slug: g.slug, region: g.region, privacy: g.privacy, member_count: g.member_count })),
    people: people.rows.filter((p) => p.display_name).slice(0, PER_SCOPE).map((p) => ({ name: p.display_name, headshot_url: p.avatar_url })),
  });
});
