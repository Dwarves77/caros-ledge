// The shape of Community: PROP-044 (it feeds nothing: the lint, attacked, and the import graph and table names checked independently), PROP-098 and PROP-051 (five customer surfaces, Community co-equal, no sixth),
// INV-225 (no text claims it reaches another surface), the route inventory, the dead-by-ruling features that were not ported, and the wiring defects that are visible in the code's shape: no browser-client table
// write beside a route, no per-page getUser, no internal id in a customer sentence.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { ESLint } from "eslint";

import { GET as roster } from "@/features/community/api/group-members";
import surfaceRules from "@/core/routing/data/surface-rules.json";

import { call, PUB, world } from "./_world.ts";

const ROOT = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");
const SRC = walk(join(ROOT, "src")).map(rel);
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** Source without comments, so a sentence in a header never reads as code. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const INSIDE = (p: string) => p.startsWith("src/features/community/") || p.startsWith("src/app/community/") || p.startsWith("src/app/api/community/") || p.startsWith("src/app/privacy/ui-fixtures/community/");

// ── PROP-044 ───────────────────────────────────────────────────────────────────────────────────────────────────

test("PROP-044: no module outside the Community directories imports Community code (the import graph)", () => {
  const offenders = SRC.filter((p) => /\.(ts|tsx|mjs)$/.test(p) && !INSIDE(p) && /from\s+["'][^"']*features\/community|import\(["'][^"']*features\/community/.test(read(p)));
  assert.deepEqual(offenders, []);
});

test("PROP-044: nothing outside the Community directories names a community_* table, except the two readers named here, each for a stated reason", () => {
  const ALLOWED: Record<string, string> = {
    "src/core/notifications/preferences.ts": "INV-242: a notification honours the recipient's own mute, which is community_group_members.muted (a read, by the one dispatch path)",
    "src/features/health/api/surfaces.ts": "an operational count of community_posts for the health route (a read-only row count; it feeds no surface)",
    "src/core/db/schema-keys.json": "the generated schema description",
  };
  const found = SRC.filter((p) => !INSIDE(p) && /community_[a-z_]+/.test(code(p)));
  assert.deepEqual(found.filter((p) => !(p in ALLOWED)), [], "a new reader of a Community table needs a reason in this list, or a different design");
  for (const p of Object.keys(ALLOWED)) assert.ok(found.includes(p) || p.endsWith(".json"), `${p} no longer names a table: remove it from the list`);
});

test("PROP-044: the lint rule is real: an import of Community code from another module is an ERROR, from a Community module it is not (attack)", async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const text = 'import { ORG_TYPES } from "@/features/community/lib/labels";\nexport const x = ORG_TYPES;\n';
  const outside = await eslint.lintText(text, { filePath: join(ROOT, "src/features/dashboard/attack.ts") });
  assert.deepEqual(outside[0]?.messages.map((m) => m.ruleId), ["no-restricted-imports"], "from the dashboard");
  const relative = await eslint.lintText('import { ORG_TYPES } from "../community/lib/labels";\nexport const x = ORG_TYPES;\n', { filePath: join(ROOT, "src/features/dashboard/attack.ts") });
  assert.deepEqual(relative[0]?.messages.map((m) => m.ruleId), ["no-restricted-imports"], "by a relative path");
  const shell = await eslint.lintText(text, { filePath: join(ROOT, "src/ui/shell/attack.tsx") });
  assert.deepEqual(shell[0]?.messages.map((m) => m.ruleId), ["no-restricted-imports"], "from the shell");
  const inside = await eslint.lintText(text, { filePath: join(ROOT, "src/features/community/ui/attack.ts") });
  assert.deepEqual(inside[0]?.messages.filter((m) => m.ruleId === "no-restricted-imports"), []);
  const route = await eslint.lintText(text, { filePath: join(ROOT, "src/app/api/community/attack/route.ts") });
  assert.deepEqual(route[0]?.messages.filter((m) => m.ruleId === "no-restricted-imports"), []);
});

// ── PROP-098 and PROP-051 ──────────────────────────────────────────────────────────────────────────────────────

test("PROP-098: exactly five customer surfaces, Community co-equal: four item surfaces and Community, each a nav entry and a page; the item router never routes to Community; no Assistant surface", () => {
  assert.deepEqual([...surfaceRules.surfaces].sort(), ["market", "operations", "regulations", "research"]);
  const nav = JSON.parse(read("src/ui/shell/data/nav.json")) as { sections: Array<{ label: string; items: Array<{ href: string }> }> };
  const hrefs = nav.sections.flatMap((s) => s.items.map((i) => i.href));
  const five = ["/regulations", "/market", "/research", "/operations", "/community"];
  assert.deepEqual(hrefs.filter((h) => five.includes(h)).sort(), [...five].sort(), "all five are top-level nav entries");
  assert.ok(nav.sections.find((s) => s.items.some((i) => i.href === "/community")), "Community has its own section: a peer of the item surfaces, not a tab inside one");
  for (const h of five) assert.ok(SRC.includes(`src/app${h}/page.tsx`), `${h} has a page`);
  assert.ok(!hrefs.some((h) => /assistant/i.test(h)) && !SRC.some((p) => /^src\/app\/assistant\//.test(p)), "the Assistant is a helper, not a sixth surface");
});

test("PROP-051: no sixth customer surface: every top-level page route is one of the five, the dashboard, or a named utility route", () => {
  const top = new Set(SRC.filter((p) => /^src\/app\/[^/]+\/.*page\.tsx$|^src\/app\/page\.tsx$/.test(p)).map((p) => p.split("/")[2] ?? ""));
  const SURFACES_FIVE = ["regulations", "market", "research", "operations", "community"];
  const UTILITY = ["admin", "auth", "bot", "dashboard", "invitations", "login", "map", "onboarding", "page.tsx", "privacy", "profile", "search", "service-unavailable", "settings", "signup", "watchlist", "workspace"];
  assert.deepEqual([...top].filter((t) => !SURFACES_FIVE.includes(t) && !UTILITY.includes(t)), [], "a new top-level route has to be named as a surface or a utility here");
  for (const s of SURFACES_FIVE) assert.ok(top.has(s));
});

// ── INV-225: no Community text says it reaches another surface ────────────────────────────────────────────────

test("INV-225: no Community sentence says Community content reaches, feeds, is promoted to or is cited by another surface", () => {
  const files = SRC.filter((p) => INSIDE(p) && /\.(ts|tsx|json)$/.test(p) && !p.endsWith("rooms.json"));
  const claim = /\b(promot(ed|ion) (to|into|path)|promote to public|editorial pickup|feeds? (into |the )?(the )?(ledger|dashboard|regulations|market|research|operations)|becomes? (a )?(source|signal|regulation)|cited by (the )?(ledger|dashboard))\b/i;
  const hits = files.filter((p) => claim.test(code(p)));
  assert.deepEqual(hits, []);
});

// ── the route inventory ────────────────────────────────────────────────────────────────────────────────────────

const ROUTES: Record<string, string[]> = {
  "api/community/entities/[entityId]/threads": ["GET"],
  "api/community/entities": ["GET"],
  "api/community/groups/[id]/invitations": ["GET"],
  "api/community/groups/[id]/invite-candidates": ["GET"],
  "api/community/groups/[id]/invite": ["POST"],
  "api/community/groups/[id]/join": ["POST"],
  "api/community/groups/[id]/members": ["DELETE", "GET"],
  "api/community/groups/[id]/mute": ["PATCH"],
  "api/community/groups/[id]/settings": ["PATCH"],
  "api/community/groups/[id]/star": ["PATCH"],
  "api/community/groups": ["POST"],
  "api/community/invitations/[id]/accept": ["POST"],
  "api/community/invitations/[id]/decline": ["POST"],
  "api/community/invitations/[id]/revoke": ["POST"],
  "api/community/moderation/reports/[id]": ["POST"],
  "api/community/moderation/reports": ["GET", "POST"],
  "api/community/notifications/[id]": ["POST"],
  "api/community/notifications/counts": ["GET"],
  "api/community/notifications": ["GET", "POST"],
  "api/community/posts/[id]/cite": ["POST"],
  "api/community/posts/[id]/remove": ["POST"],
  "api/community/posts/[id]/replies": ["GET", "POST"],
  "api/community/posts/[id]/signoff": ["POST"],
  "api/community/posts/[id]": ["DELETE", "PATCH"],
  "api/community/posts": ["GET", "POST"],
  "api/community/profile/verify": ["GET", "POST"],
  "api/community/profile": ["GET", "PUT"],
  "api/community/search": ["GET"],
  "api/community/signoff/[id]/decide": ["POST"],
  "api/community/signoff/[id]/withdraw": ["POST"],
};

test("the route inventory: exactly these Community routes with exactly these methods, each a re-export of a handler that refuses a signed-out caller", async () => {
  const found = SRC.filter((p) => /^src\/app\/api\/community\/.*route\.ts$/.test(p)).map((p) => p.replace(/^src\/app\//, "").replace(/\/route\.ts$/, ""));
  assert.deepEqual(found.sort(), Object.keys(ROUTES).sort(), "no route added or dropped without this list");
  for (const [path, methods] of Object.entries(ROUTES)) {
    const mod = (await import(pathToFileURL(join(ROOT, "src/app", path, "route.ts")).href)) as Record<string, unknown>;
    const exported = Object.keys(mod).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k)).sort();
    assert.deepEqual(exported, methods, path);
    world();
    for (const m of methods) {
      const params = Object.fromEntries([...path.matchAll(/\[(\w+)\]/g)].map((x) => [x[1] ?? "", PUB]));
      const res = await call(mod[m] as never, "anon", m, `/${path}`, m === "GET" || m === "DELETE" ? undefined : {}, params);
      assert.equal(res.status, 401, `${m} /${path} without a session`);
    }
  }
});

test("the ruled-dead features are not ported: no promotion, no editorial pickup, no vendor directory, no benchmark instruments, no keyset listings cursor, no notices route, no @mentions", () => {
  const names = SRC.filter((p) => INSIDE(p)).join("\n");
  assert.doesNotMatch(names, /HowPublishing|promot|editorial|vendor|benchmark|listings|notices|mention/i);
  const text = SRC.filter((p) => INSIDE(p) && /\.tsx?$/.test(p)).map(code).join("\n");
  assert.doesNotMatch(text, /HowPublishingWorks|promoted_from|editorial_pickup|vendor_directory|benchmark_instrument|after_priority|@mention|on_mention_in/i);
});

// ── wiring defects visible in the code's shape ────────────────────────────────────────────────────────────────

test("wiring 3: nothing under Community's UI or pages, or the shell's inbox, writes a table or calls the network except through the typed client (the leave and cite writes sat in the browser beside the routes)", () => {
  const files = SRC.filter((p) => (p.startsWith("src/features/community/ui/") || p.startsWith("src/features/community/pages/") || p.startsWith("src/ui/shell/notifications/")) && /\.tsx?$/.test(p));
  assert.ok(files.length > 30);
  const bad: string[] = [];
  for (const p of files) {
    const c = code(p);
    const page = p.startsWith("src/features/community/pages/");
    // A client part never touches a table or an rpc; a server page may read, but only on the caller's own client (no service client, no fetch).
    if (/\bfetch\(|createBrowserClient|supabase-js|@supabase|XMLHttpRequest/.test(c) || (!page && /\.from\(|\.rpc\(/.test(c)) || (page && /serviceClient/.test(c))) bad.push(p);
  }
  assert.deepEqual(bad, []);
});

test("wiring 2: every part that runs a member action reaches the one toast, so a failed action is said", () => {
  const needs = SRC.filter((p) => p.startsWith("src/features/community/ui/") && /\.tsx$/.test(p)).filter((p) => /\b(setGroupPref|actOnReport|setMembership|citeItem)\(/.test(code(p)));
  assert.ok(needs.length >= 3, `found ${needs.join(", ")}`);
  assert.deepEqual(needs.filter((p) => !/useToast\(\)/.test(code(p))), []);
});

test("no page asks the auth server who the caller is (getUser per page): the claims are checked locally", () => {
  const bad = SRC.filter((p) => INSIDE(p) && /\.tsx?$/.test(p)).filter((p) => /\.getUser\(/.test(code(p)));
  assert.deepEqual(bad, []);
});

test("no internal id, table name or uuid in a customer sentence: a malformed id is named by what it is, and an error from the database is replaced by the route's own words", async () => {
  world();
  const res = await call(roster, "member", "GET", "/api/community/groups/not-a-uuid/members", undefined, { id: "not-a-uuid" });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error), /group id/i);
  assert.doesNotMatch(String(res.body.error), /uuid|guid|community_|public\./i);
});
