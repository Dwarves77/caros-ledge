// scripts/ci/ui-checks.mjs can fail (G4): every rule has a planted violation that turns it red and a clean twin that keeps it green, the five violations the audit planted in the old check (R3) are all red, the allow
// list is a ratchet in both directions. The check is run as a program on a throwaway tree, as CI runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("scripts/ci/ui-checks.mjs");
const BASE_CSS = ".cl-ok { margin: 0; }\n.cl-chip-ok { margin: 0; }\n";
const THEME_CSS = ":root { --ink: #111; --sp-12: 12px; }\n";
const BUTTON_OK = 'import type { ButtonHTMLAttributes } from "react";\ninterface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "style"> {}\nexport const Button = (p: ButtonProps) => null;\n';

/** A throwaway tree with the kit's two stylesheets, plus `files`; returns the check's result. `allow` is the allow-file text, if any. */
function run(files, allow) {
  const dir = mkdtempSync(join(tmpdir(), "uichecks-"));
  const put = (rel, text) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  };
  put("src/ui/base.css", BASE_CSS);
  put("src/ui/theme.css", THEME_CSS);
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  if (allow) put("scripts/ci/ui-checks-allow.json", typeof allow === "string" ? allow : JSON.stringify(allow));
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}

const UI = "src/ui/A.tsx";
const FEATURE = "src/features/x/ui/P.tsx";
/** One planted violation per rule (`bad`), and the same file made right (`good`). */
const FIXTURES = {
  "style-element": { bad: { [UI]: "export const A = () => <div><style>{'x'}</style></div>;\n" }, good: { [UI]: "export const A = () => <div />;\n" } },
  "colour-literal": { bad: { [UI]: "export const c = `#ff0000`;\n" }, good: { [UI]: 'export const c = "var(--ink)";\n' } },
  "colour-built-at-runtime": { bad: { "src/ui/impact.ts": "export const f = (n: number) => `#${n.toString(16)}`;\n" }, good: { "src/ui/impact.ts": 'export const f = (id: string) => `#${id}`;\n' } },
  "style-colour": { bad: { [FEATURE]: 'export const P = () => <div style={{ color: "red" }} />;\n' }, good: { [FEATURE]: 'export const P = () => <div style={{ color: "var(--ink)" }} />;\n' } },
  "style-px": { bad: { [FEATURE]: "export const P = () => <div style={{ padding: 12 }} />;\n" }, good: { [FEATURE]: 'export const P = () => <div style={{ padding: "var(--sp-12)", opacity: 1 }} />;\n' } },
  "target-height": { bad: { [FEATURE]: "export const P = () => <button style={{ height: 20 }}>go</button>;\n" }, good: { [FEATURE]: 'export const P = () => <button style={{ minHeight: "var(--target)" }}>go</button>;\n' } },
  "data-layer-import": { bad: { [UI]: 'import { db } from "@/core/db/client";\nexport const x = db;\n' }, good: { [UI]: 'import { x } from "@/core/shared";\nexport { x };\n' } },
  "media-outside-base": { bad: { [UI]: 'export const q = "@media (max-width: 10px)";\n' }, good: { [UI]: 'export const q = "(max-width: 10px)";\n' } },
  "var-unresolved": { bad: { [UI]: 'export const s = "var(--nope)";\n' }, good: { [UI]: 'export const s = "var(--ink)";\n' } },
  "class-undefined": { bad: { [UI]: 'export const A = ({ x }: { x: string }) => <div className={`cl-chip-${x} cl-missing`} />;\n' }, good: { [UI]: 'export const A = ({ x }: { x: string }) => <div className={`cl-chip-${x} cl-ok`} />;\n' } },
  "cl-btn-outside-button": { bad: { [FEATURE]: 'export const P = () => <button className="cl-btn cl-btn--secondary">go</button>;\n' }, good: { [FEATURE]: 'export const P = () => <button className="cl-ok">go</button>;\n' } },
  "raw-form-control": { bad: { [FEATURE]: "export const P = () => <input />;\n" }, good: { [FEATURE]: "export const P = () => <div />;\n" } },
  "details-open": { bad: { [FEATURE]: "export const P = () => <details open><summary>s</summary></details>;\n" }, good: { [FEATURE]: "export const P = () => <details><summary>s</summary></details>;\n" } },
  "wall-clock": { bad: { "src/core/t.ts": "export const t = () => new Date();\nexport const u = () => Date.now();\n" }, good: { "src/core/t.ts": "export const t = (now: () => Date) => now();\nexport const u = (iso: string) => new Date(iso);\n" } },
  "bare-fetch": { bad: { [FEATURE]: 'export const g = () => fetch("/api/x");\n' }, good: { [FEATURE]: 'import { requestJson } from "@/core/http/request-json";\nexport const g = () => requestJson("/api/x");\n' } },
  "kit-fetch": { bad: { [UI]: 'import { requestJson } from "@/core/http/request-json";\nexport const load = () => requestJson("/api/x");\n' }, good: { [UI]: "export const load = (rows: string[]) => rows;\n" } },
  "kit-imports-feature": { bad: { [UI]: 'import { useAuth } from "@/features/auth/ui/AuthProvider";\nexport const x = useAuth;\n' }, good: { [UI]: 'import { x } from "@/core/shared";\nexport { x };\n' } },
  "entity-in-string": { bad: { [FEATURE]: 'export const s = "the finding&apos;s brief";\n' }, good: { [FEATURE]: 'export const P = () => <p title="a &amp; b">the finding&apos;s brief</p>;\n' } },
  "http-error-message": { bad: { "src/features/x/api/h.ts": "export const f = (error: Error) => { throw new HttpError(500, error.message); };\n" }, good: { "src/features/x/api/h.ts": 'export const f = () => { throw new HttpError(500, "The request could not be completed. Try again."); };\n' } },
  "supabase-error-unhandled": {
    bad: { "src/features/x/read.ts": 'export async function f(sb: any) {\n  const r = await sb.from("t").select("id");\n  return r.data;\n}\n' },
    good: { "src/features/x/read.ts": 'export async function f(sb: any) {\n  const { data, error } = await sb.from("t").select("id");\n  if (error) throw new Error("t could not be read");\n  return data;\n}\n' },
  },
  "model-id-literal": { bad: { "src/features/x/m.ts": 'export const m = "claude-sonnet-4";\n' }, good: { "src/features/x/m.ts": 'export const m = "the injected brief";\n' } },
  "cron-literal": { bad: { "src/features/x/c.ts": 'export const c = "*/5 * * * *";\n' }, good: { "src/features/x/c.ts": 'export const c = "every five minutes, dispatched";\n' } },
  "button-rest-style": { bad: { "src/ui/Button.tsx": 'import type { ButtonHTMLAttributes } from "react";\ninterface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {}\nexport const Button = (p: ButtonProps) => null;\n' }, good: { "src/ui/Button.tsx": BUTTON_OK } },
  "style-on-kit-part": { bad: { [FEATURE]: 'import { Button } from "@/ui";\nexport const P = () => <Button style={{ opacity: 1 }}>go</Button>;\n' }, good: { [FEATURE]: 'import { Button } from "@/ui";\nexport const P = () => <Button>go</Button>;\n' } },
  "css-px-scale": { bad: { "src/features/x/ui/x.module.css": ".a { padding: 12px 8px; }\n" }, good: { "src/features/x/ui/x.module.css": ".a { padding: var(--sp-12) 0; border: 1px solid; }\n" } },
};

for (const [rule, { bad, good }] of Object.entries(FIXTURES)) {
  test(`${rule}: the planted violation is red and names the rule; the same file made right is green`, () => {
    const red = run(bad);
    assert.equal(red.status, 1, `${rule} did not turn red:\n${red.stdout}${red.stderr}`);
    assert.match(red.stderr, new RegExp(`\\(${rule}[;)]`), `the report names the rule:\n${red.stderr}`);
    const green = run(good);
    assert.equal(green.status, 0, `the clean twin of ${rule} is red:\n${green.stdout}${green.stderr}`);
  });
}

test("R3: the five violations the old check printed clean are all red: a template-literal hex, a colour name, hsl(), a 20 px button and a class that is never defined", () => {
  const r = run({
    [UI]: [
      "export const hex = `#ff0000`;",
      "export const hsl = 'hsl(0 100% 50%)';",
      "export const A = ({ x }: { x: string }) => (",
      '  <div className={`cl-pill-${x}`} style={{ color: "red" }}>',
      "    <button style={{ height: 20 }}>go</button>",
      "  </div>",
      ");",
      "",
    ].join("\n"),
  });
  assert.equal(r.status, 1);
  for (const rule of ["colour-literal", "style-colour", "target-height", "class-undefined"]) assert.match(r.stderr, new RegExp(`\\(${rule}[;)]`), `${rule} is reported:\n${r.stderr}`);
  assert.ok((r.stderr.match(/colour-literal/g) ?? []).length >= 2, "both the hex and the colour function are reported");
});

test("entities in JSX attributes are decoded by JSX and are not reported; entities in JSX text likewise", () => {
  assert.equal(run({ [FEATURE]: 'export const P = () => <a title="Tom &amp; Jerry">the finding&apos;s brief</a>;\n' }).status, 0);
});

test("a raw form control is allowed inside FormField.tsx itself and nowhere else", () => {
  assert.equal(run({ "src/ui/FormField.tsx": "export const Input = () => <input />;\n" }).status, 0);
  assert.equal(run({ "src/ui/Other.tsx": "export const Input = () => <input />;\n" }).status, 1);
});

test("a database read passed to a helper that owns the failure, or read as .error, or handed back, is handled; a write is not a read", () => {
  const ok = [
    'export async function a(sb: any) { return await sb.from("t").select("id"); }',
    'export async function b(sb: any) { const r = await sb.from("t").select("id"); if (r.error) throw new Error("x"); return r.data; }',
    'export async function c(sb: any) { return one(await sb.from("t").select("id")); }',
    'export async function d(sb: any) { return await exactCount(sb.from("t").select("id", { count: "exact", head: true })); }',
    'export async function e(sb: any) { await sb.from("t").update({ a: 1 }).eq("id", 1); }',
  ].join("\n");
  assert.equal(run({ "src/features/x/read.ts": `${ok}\n` }).status, 0);
});

test("the allow list is a ratchet in both directions and every entry carries its reason and owner", () => {
  const bad = { [FEATURE]: "export const P = () => <div style={{ padding: 12 }} />;\n" };
  const entry = (files, over = {}) => ({ rules: { "style-px": { owner: "R4b", reason: "the scale is not adopted by this screen yet", files, ...over } } });
  assert.equal(run(bad, entry({ [FEATURE]: 1 })).status, 0, "the listed debt is allowed");
  const more = run({ [FEATURE]: "export const P = () => <div style={{ padding: 12, margin: 8 }} />;\n" }, entry({ [FEATURE]: 1 }));
  assert.equal(more.status, 1, "one more offence than listed is red");
  assert.match(more.stderr, /1 allowed in this file, 2 found/);
  const fewer = run({ [FEATURE]: "export const P = () => <div />;\n" }, entry({ [FEATURE]: 1 }));
  assert.equal(fewer.status, 1, "an entry whose debt was paid is red until it is lowered");
  assert.match(fewer.stderr, /allows 1 in .* and finds 0; lower the count/);
  assert.equal(run(bad, entry({ [FEATURE]: 1 }, { reason: "short" })).status, 1, "a rule entry without a reason is red");
  assert.equal(run(bad, entry({ [FEATURE]: 1 }, { owner: "" })).status, 1, "a rule entry without an owner is red");
  assert.equal(run(bad, entry({ [FEATURE]: { count: 1, reason: "no" } })).status, 1, "a file entry with a reason of its own needs a real one");
  assert.equal(run(bad, entry({ [FEATURE]: { count: 1, reason: "this screen restyles one card on purpose" } })).status, 0);
  assert.equal(run(bad, { rules: { "no-such-rule": { owner: "R4b", reason: "a rule that does not exist at all", files: {} } } }).status, 1, "an entry naming no rule is red");
});
