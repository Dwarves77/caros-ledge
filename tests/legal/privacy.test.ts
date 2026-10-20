// R2e M4, INV-R2e-3: the privacy page names exactly the processors the code has, and every right it states names a route, page or address that exists. The page is generated from src/features/legal/data (processors.json,
// rights.json); this file holds that data equal to the tree in BOTH directions: a processor named there and absent from the code fails, and a dependency, an outbound host or a workflow in the code that the data does not classify fails.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

import PrivacyPolicyPage from "@/app/privacy/page";
import { PROCESSORS, RIGHTS } from "@/features/legal/lib/privacy";

import { renderApp, textOf } from "../_support/render.ts";

const read = (p: string): string => readFileSync(p, "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : /\.(ts|tsx)$/.test(n) ? [`${dir}/${n}`] : []));
/** The code that ships: the app, and the Edge Function that fetches public documents. Tests and scripts are not the product. */
const CODE = [...walk("src"), ...walk("supabase/functions")];
const text = new Map(CODE.map((f) => [f, read(f)]));
const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };

const processorDeps = PROCESSORS.processors.flatMap((p) => p.evidence.dependencies ?? []);
const processorHosts = PROCESSORS.processors.flatMap((p) => p.evidence.hosts ?? []);

/** Every host a code file writes as a URL literal (a leading `{s}.` subdomain template stripped). A host built at run time from a registered source is a public document the registry names, not a literal here. */
function hostsInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [file, body] of text) for (const m of body.matchAll(/https?:\/\/(?:\{\w+\}\.)?([a-z0-9][a-z0-9.-]*[a-z0-9])/gi)) found.set((m[1] as string).toLowerCase(), file);
  return found;
}
const reserved = (h: string): boolean => /(^|\.)(example\.(com|org|net|test)|invalid|test|localhost)$/.test(h) || h === "localhost";

test("INV-R2e-3 (data to code): every processor the page names has its evidence in the tree: a dependency in package.json, a file, or a host in the code", () => {
  for (const p of PROCESSORS.processors) {
    const { dependencies = [], files = [], hosts = [] } = p.evidence;
    assert.ok(dependencies.length + files.length + hosts.length > 0, `${p.id} names no evidence`);
    for (const d of dependencies) assert.ok(d in pkg.dependencies, `${p.id}: ${d} is not a dependency of this tree`);
    for (const f of files) assert.ok(existsSync(f), `${p.id}: ${f} does not exist`);
    for (const h of hosts) assert.ok([...text.values()].some((body) => body.includes(h)), `${p.id}: no code calls ${h}`);
  }
  assert.equal(new Set(PROCESSORS.processors.map((p) => p.id)).size, PROCESSORS.processors.length, "a processor is named once");
});

test("INV-R2e-3 (code to data): every runtime dependency, every outbound host and the CI workflow is classified by the data: a processor's evidence, a library, a public source, or the platform's own host", () => {
  const classifiedDeps = new Set([...processorDeps, ...PROCESSORS.libraries]);
  assert.deepEqual(Object.keys(pkg.dependencies).filter((d) => !classifiedDeps.has(d)), [], "a dependency the privacy data does not classify (a new SDK is a new processor until it is shown not to be)");
  assert.deepEqual(PROCESSORS.libraries.filter((l) => !(l in pkg.dependencies)), [], "a library the data lists that the tree no longer has");
  const known = new Set([...processorHosts, ...PROCESSORS.publicHosts, ...PROCESSORS.ownHosts]);
  const unclassified = [...hostsInCode()].filter(([h]) => !reserved(h) && !known.has(h)).map(([h, file]) => `${h} (${file})`);
  assert.deepEqual(unclassified, [], "an outbound host in the code that neither the processors nor the public sources name");
  const publicUnused = PROCESSORS.publicHosts.filter((h) => !hostsInCode().has(h));
  assert.deepEqual(publicUnused, [], "a public host the data lists that no code names any more");
  assert.ok(PROCESSORS.processors.some((p) => (p.evidence.files ?? []).includes(".github/workflows/ci.yml")) && existsSync(".github/workflows/ci.yml"), "the CI workflow's processor is named");
});

test("the page renders exactly the data: every processor and every right appears with its route, page or address; none of the removed vendors does", () => {
  const page = textOf(renderApp(PrivacyPolicyPage()));
  for (const p of PROCESSORS.processors) assert.ok(page.includes(p.name) && page.includes(p.role), `${p.name} is on the page`);
  for (const r of RIGHTS.rights) {
    assert.ok(page.includes(r.label), `${r.label} is on the page`);
    const h = r.how;
    assert.ok(page.includes("route" in h ? h.route : "page" in h ? "profile" : h.address), `${r.id}: the page says where to use it`);
  }
  assert.doesNotMatch(page, /anthropic|browserless|linkedin|stripe|openai/i, "a vendor the code does not use is not named");
  assert.match(page, /Download my data/);
  assert.match(page, /Delete my account/);
});

test("every right names a route that exists and honours it, a page that exists, or the contact address; the six rights the brief names are all present", () => {
  const ids = RIGHTS.rights.map((r) => r.id);
  for (const need of ["access", "correction", "deletion", "objection", "complaint", "portability"]) assert.ok(ids.includes(need), `${need} is stated`);
  for (const r of RIGHTS.rights) {
    const h = r.how;
    if ("route" in h) {
      const [method, path] = h.route.split(" ") as [string, string];
      const file = `src/app${path}/route.ts`;
      assert.ok(existsSync(file), `${r.id}: ${file} does not exist`);
      assert.match(read(file), new RegExp(`export const ${method}\\b|\\bas ${method}\\b|export \\{[^}]*\\b${method}\\b`), `${r.id}: ${file} does not handle ${method}`);
    } else if ("page" in h) assert.ok(existsSync(`src/app${h.page}/page.tsx`), `${r.id}: ${h.page} is not a page`);
    else assert.equal(h.address, RIGHTS.contact, `${r.id}: the address is the one contact`);
  }
});
