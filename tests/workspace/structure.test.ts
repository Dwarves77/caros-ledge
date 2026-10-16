import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path/posix";
import { test } from "node:test";

import * as core from "@/core/workspace";
import * as settings from "@/features/settings";
import * as state from "@/features/workspace/state";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const text = (f: string) => readFileSync(f, "utf8");
const has = (mod: object, names: string[]) => assert.deepEqual(names.filter((n) => !(n in mod)), []);

const ROUTES: Record<string, { feature: string; methods: string[] }> = {
  "src/app/api/workspace/overrides/route.ts": { feature: "overrides", methods: ["POST", "DELETE"] },
  "src/app/api/workspace/personal-state/route.ts": { feature: "personal-state", methods: ["GET", "POST", "DELETE"] },
  "src/app/api/workspace/archive-impact/route.ts": { feature: "archive-impact", methods: ["GET"] },
  "src/app/api/workspace/bootstrap/route.ts": { feature: "bootstrap", methods: ["GET"] },
  "src/app/api/workspace/items/[id]/notes/route.ts": { feature: "notes", methods: ["GET", "POST", "PATCH", "DELETE"] },
  "src/app/api/workspace/items/[id]/assignments/route.ts": { feature: "assignments", methods: ["GET", "POST", "PATCH", "DELETE"] },
  "src/app/api/workspace/tags/route.ts": { feature: "tags", methods: ["GET", "POST", "DELETE"] },
  "src/app/api/workspace/tags/[id]/items/route.ts": { feature: "tag-items", methods: ["PUT", "DELETE"] },
  "src/app/api/workspace/portfolios/route.ts": { feature: "portfolios", methods: ["GET", "POST"] },
  "src/app/api/workspace/portfolios/[id]/route.ts": { feature: "portfolio-detail", methods: ["GET", "PATCH", "DELETE"] },
  "src/app/api/workspace/portfolios/[id]/members/route.ts": { feature: "portfolio-members", methods: ["POST", "DELETE"] },
};

test("the old URLs are kept: every workspace route is a thin re-export of its feature handler with the same methods, and every handler is behind a guard", () => {
  const found = files("src/app/api/workspace").filter((f) => f.endsWith("/route.ts")).sort();
  assert.deepEqual(found, Object.keys(ROUTES).sort());
  for (const [route, { feature, methods }] of Object.entries(ROUTES)) {
    const body = text(route);
    const exported = /export \{ ([^}]+) \} from "@\/features\/workspace\/api\/([^"]+)"/.exec(body);
    assert.ok(exported, `${route} re-exports a feature handler`);
    assert.equal(exported[2], feature, route);
    assert.deepEqual(exported[1]!.split(",").map((s) => s.trim()).sort(), [...methods].sort(), route);
    assert.match(text(`src/features/workspace/api/${feature}.ts`), /requireUser|requireOrgRole|runCollab/, `${feature} has no guard`);
    assert.equal(body.split("\n").length <= 3, true, `${route} stays a re-export`);
  }
});

test("PROP-011: the per-viewer lens takes its service client from the one factory and never builds a client or reads the service key itself", () => {
  const lens = text("src/core/workspace/viewer-relevance.ts");
  assert.match(lens, /serviceClient\(\)/);
  assert.doesNotMatch(lens, /createClient|createServerClient|SUPABASE_SERVICE_ROLE_KEY/);
  for (const f of [...files("src/core/workspace"), ...files("src/features/workspace"), ...files("src/features/settings"), ...files("src/features/account")]) {
    assert.doesNotMatch(text(f), /createClient\(|createServerClient\(|createBrowserClient\(|SUPABASE_SERVICE_ROLE_KEY/, f);
  }
});

test("the interface the brief names exists", () => {
  has(core, [
    "getWorkspaceProfile", "DEFAULT_WORKSPACE_PROFILE", "ORG_ROLES", "ORG_SIZE_DIMENSIONS", "findBand", "parseOrgProfile", "validateProfileInput", "relevanceForItem", "getViewerRelevanceForItem", "computeItemRelevance",
    "summariseObligationBinding", "currentObligationObjects", "dutyHoldersExcludeForwarder", "fetchObligationObjectsForItem", "runCollab", "loadRoster", "orgWatchersOf", "canWrite", "isOrgAdmin", "useWorkspaceStore", "applyWorkspaceSeed",
    "patchWorkspaceSettings", "ALL_SECTORS", "JURISDICTIONS", "MODES", "REGIONS",
  ]);
  has(state, ["useItemStateStore", "mergeWithOverrides"]);
  has(settings, ["useSettingsStore", "reloadSettings"]);
  assert.match(text("src/core/types/index.ts"), /export type \{[^}]*\bResource\b[^}]*\} from "\.\/item"/);
  assert.match(text("src/core/shared/dates.ts"), /export function isIsoDate/);
});

test("rule tables are data: the vocabularies live in JSON and the logic file holds no role or band literal", () => {
  const vocabulary = JSON.parse(text("src/core/workspace/data/org-vocabulary.json")) as { roles: unknown[] };
  assert.equal(vocabulary.roles.length, 8);
  assert.doesNotMatch(text("src/core/workspace/profile.ts"), /importer_of_record|warehouse_operator|Micro \(under/);
});

test("nothing in this slice calls a metered model, schedules work, or reads the wall clock inside a render path", () => {
  for (const f of [...files("src/core/workspace"), ...files("src/features/workspace"), ...files("src/features/settings"), ...files("src/features/account")]) {
    const body = text(f);
    assert.doesNotMatch(body, /@anthropic-ai|from "openai"|browserless|\bcron\b|setInterval\(/i, f);
  }
});

test("INV-168, IMP-022: patchWorkspaceSettings is the one writer of workspace_settings; the first write on a brand-new org goes through it too", () => {
  const writers = files("src").filter((f) => /\.from\("workspace_settings"\)[\s\S]{0,80}\.(update|insert|upsert)\(/.test(text(f)));
  assert.deepEqual(writers, ["src/core/workspace/settings.ts"]);
});
