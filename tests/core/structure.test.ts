import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const src = files("src").map((f) => f.split(sep).join("/")).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string): string => relative("src", f).split(sep).join("/");
const text = (f: string) => readFileSync(f, "utf8");

// A guard is any require* function or *Guard function; a wrapper is any function in the tree whose own body calls one
// (runCollab, a token wrapper). Both are read from the tree, so a slice that adds a route or a wrapper edits no literal here.
const GUARD_CALL = /\b(require[A-Z]\w*|\w*Guard)\(/;
const wrappers = new Set<string>();
for (const f of src) {
  for (const seg of text(f).split(/\n(?=(?:export )?(?:async )?function )/)) {
    const name = /^(?:export )?(?:async )?function (\w+)/.exec(seg)?.[1];
    if (name && GUARD_CALL.test(seg)) wrappers.add(name);
  }
}
const isGuarded = (body: string): boolean => GUARD_CALL.test(body) || [...wrappers].some((w) => new RegExp(`\\b${w}\\(`).test(body));

/** A feature barrel (the server surface of a feature, IMP-106) re-exports a handler from the file that defines it: follow `export { GET as name } from "./path"` to that file, so the guard is read where the handler is. */
const definingFile = (file: string, name: string): string => {
  const m = new RegExp(String.raw`export \{ \w+ as ${name} \} from "\./([^"]+)"`).exec(text(file));
  return m ? `${file.slice(0, file.lastIndexOf("/"))}/${m[1]}.ts` : file;
};

test("PROP-001/160: every route handler is behind a guard, or is one of the two public auth endpoints", () => {
  const publicRoutes = new Set(["src/features/auth/api/identity.ts", "src/features/auth/api/callback.ts"]);
  // Public by documented exception (operator-approved 2026-07-11): build metadata only, no database, no parameters, nothing to limit.
  const documentedPublic = new Set(["src/features/telemetry/api/version.ts"]);
  const routes = src.filter((f) => f.endsWith("/route.ts"));
  assert.ok(routes.length > 0, "no route files found");
  for (const route of routes) {
    const target = /from "@\/(features\/[^"]+)"/.exec(text(route))?.[1];
    assert.ok(target, `${route} re-exports a feature handler`);
    const handler = definingFile(`src/${target}.ts`, /export \{\s*(\w+)/.exec(text(route))?.[1] ?? "GET");
    const body = text(handler);
    if (documentedPublic.has(handler)) continue;
    if (publicRoutes.has(handler)) assert.match(body, /checkRateLimit/, `${handler} is public, so it must rate limit`);
    else assert.ok(isGuarded(body), `${handler} has no guard`);
  }
});

test("PROP-028/127 and PROP-011/109: one module attaches the bearer, one factory builds service clients", () => {
  const mentions = (re: RegExp) => src.filter((f) => re.test(text(f))).map(rel).sort();
  // The third holder is the e-mail provider's own API key (core/shared/email.ts, IMP-014): a different credential to a different service, not the user's session bearer.
  assert.deepEqual(mentions(/authorization/i), ["core/db/clients.ts", "core/http/authed-fetch.ts", "core/shared/email.ts"]);
  assert.deepEqual(mentions(/SUPABASE_SERVICE_ROLE_KEY/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateClient\(/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateServerClient\(/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateBrowserClient\(/), ["core/db/browser.ts"]);
});

test("the console is touched by the logger alone", () => {
  assert.deepEqual(src.filter((f) => /\bconsole\./.test(text(f))).map(rel), ["core/shared/log.ts"]);
});

test("no auth code reads the user over the network per request: getClaims, never getUser, on the server", () => {
  const server = src.filter((f) => !f.endsWith(".tsx") && !f.includes("/ui/"));
  assert.deepEqual(server.filter((f) => /auth\.getUser\(/.test(text(f))), []);
});

test("every source file under src/core and src/features is under 400 lines", () => {
  for (const f of src) assert.ok(text(f).split("\n").length <= 400, `${f} is over 400 lines`);
});

// INV-CBN-1 (CARBON-1): no price, distance, payload or intensity is a constant anywhere in src. Each is read from the store (the derived values the propagate stage writes), so a number bound to a name that says what it is
// is the defect: a declaration (`const carbonPrice = 85`) or an object member (`payloadTonnes: 14`). The physical constants and unit conversions live in propagation/data/carbon.json under names that are not these.
const CARBON_NAME = "(?:price|distance|payload|intensity)";
const CARBON_DECLARATION = new RegExp(String.raw`\b(?:const|let|var)\s+\w*${CARBON_NAME}\w*\s*(?::[^=;]+)?=\s*-?\d`, "i");
const CARBON_MEMBER = new RegExp(String.raw`^\s*["']?\w*${CARBON_NAME}\w*["']?\s*:\s*-?\d`, "i");
const constantsOf = (source: string): string[] => source.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l) && (CARBON_DECLARATION.test(l) || CARBON_MEMBER.test(l))).map((l) => l.trim());

test("INV-CBN-1: no constant for the carbon price, the distance, the payload or the intensity exists in src", () => {
  assert.deepEqual(src.flatMap((f) => constantsOf(text(f)).map((l) => `${f}: ${l}`)), []);
  assert.equal(constantsOf("export const CARBON_PRICE_EUR_T = 85;").length, 1, "a planted constant price is found");
  assert.equal(constantsOf("const corridorDistanceKm: number = 9000;").length, 1, "a typed declaration is found");
  assert.equal(constantsOf("const x = { payloadTonnes: 14 };\n  payloadTonnes: 14,").length, 1, "an object member is found");
  assert.equal(constantsOf("  defaultIntensity: 16,").length, 1);
  assert.equal(constantsOf("const priceBoard = fetchBoard(1);\nconst distanceLabel = 'km';").length, 0, "a name with no number bound to it is not one");
});

// INV-CN2-3 (CONNECT-2): no quantity, rate, price or factor is a constant in the coupling vocabulary or the pattern detectors. Each is read from the store (a stored row's value, the unit of a derived value) or from the validated data files (a threshold in patterns.json, a window in
// couplings.json); a number bound to a name that says what it is, in code, is the defect: a declaration (`const abatementCost = 90`) or an object member (`tonnageCutoff: 5000`).
const CN2_NAME = "(?:quantit|rate|price|factor|tonnage|abatement|cost|intensity|ratio|ceiling|cutoff|threshold|volume|capacity)";
const CN2_DECLARATION = new RegExp(String.raw`\b(?:const|let|var)\s+\w*${CN2_NAME}\w*\s*(?::[^=;]+)?=\s*-?\d`, "i");
const CN2_MEMBER = new RegExp(String.raw`^\s*["']?\w*${CN2_NAME}\w*["']?\s*:\s*-?\d`, "i");
const cn2Constants = (source: string): string[] => source.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l) && (CN2_DECLARATION.test(l) || CN2_MEMBER.test(l))).map((l) => l.trim());

test("INV-CN2-3: no typed quantity, rate, price or factor in src/core/coupling or the pattern detectors", () => {
  const scope = src.filter((f) => /^src\/core\/(coupling|flywheel\/patterns)\//.test(f));
  assert.ok(scope.length >= 10, "the scope is read from the tree");
  assert.deepEqual(scope.flatMap((f) => cn2Constants(text(f)).map((l) => `${f}: ${l}`)), []);
  assert.equal(cn2Constants("const abatementCost = 90;").length, 1, "a planted constant abatement cost is found");
  assert.equal(cn2Constants("export const TONNAGE_CUTOFF: number = 5000;").length, 1, "a typed declaration is found");
  assert.equal(cn2Constants("const limits = {\n  gridCapacity: 40,\n};").length, 1, "an object member is found");
  assert.equal(cn2Constants("const ratioOfBase = base.length / w;\nconst priceLabel = 'EUR';").length, 0, "a name with no number bound to it is not one");
});
