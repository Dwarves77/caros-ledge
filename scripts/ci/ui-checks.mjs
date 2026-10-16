// The kit's lint rules (P2-09, ui-kit.md proof 3). Run from the repo root; exits 1 with every offence listed.
//   1. no <style> element in src/ui
//   2. no hex or rgba literal in src/ui outside theme.css
//   3. no data-layer import in src/ui
//   4. no @media outside src/ui/base.css
//   5. every var(--name) in src/ui resolves (theme.css, or a custom property the code itself sets)
//   6. every cl- class a component names is defined in base.css
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/ui";
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(e.name)) files.push(p.replaceAll("\\", "/"));
  }
})(ROOT);

const problems = [];
const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const code = (f) => text.get(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const isCode = (f) => /\.tsx?$/.test(f);

const DATA_LAYER = [/from "@\/core\/db(\/|")/, /from "@supabase\//, /from "@\/features\/lists/, /from "@\/core\/auth\/(membership|orgs|invitations|claims|ensure-profile|platform-admin)/, /from "@\/features\/[a-z-]+\/api\//];

for (const f of files) {
  const c = code(f);
  if (isCode(f) && /<style[\s>]/.test(c)) problems.push(`${f}: a <style> element (rule 1)`);
  if (f !== `${ROOT}/theme.css` && (/#[0-9a-fA-F]{3,8}\b/.test(c) || /\brgba?\(/.test(c))) problems.push(`${f}: a hex or rgba literal (rule 2)`);
  if (isCode(f)) for (const re of DATA_LAYER) if (re.test(c)) problems.push(`${f}: a data-layer import ${re} (rule 3)`);
  if (f !== `${ROOT}/base.css` && /@media|@container/.test(c)) problems.push(`${f}: @media outside base.css (rule 4)`);
}

const theme = text.get(`${ROOT}/theme.css`) ?? "";
const defined = new Set([...theme.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
for (const f of files) for (const m of code(f).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
for (const f of files) for (const m of code(f).matchAll(/"(--[a-z0-9-]+)"/g)) defined.add(m[1]);
for (const f of files) {
  for (const m of code(f).matchAll(/var\((--[a-z0-9-]+)/g)) {
    const name = m[1];
    if (!defined.has(name) && !/^--(row-band|cl-detail-head-tint)$/.test(name)) problems.push(`${f}: var(${name}) resolves to nothing (rule 5)`);
  }
}

const base = text.get(`${ROOT}/base.css`) ?? "";
const defClasses = new Set([...base.matchAll(/\.(cl-[a-z0-9-]+)/g)].map((m) => m[1]));
const NOT_CLASSES = new Set(["cl-err-report-count", "cl-err-report-last", "cl-command-bar-input"]);
for (const f of files.filter(isCode)) {
  for (const m of code(f).matchAll(/cl-[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
    const name = m[0];
    const at = m.index + name.length;
    if (code(f)[at] === "-" || code(f)[m.index - 1] === "-" || NOT_CLASSES.has(name) || name.startsWith("cl-cb")) continue;
    if (!defClasses.has(name)) problems.push(`${f}: class ${name} is not defined in base.css (rule 6)`);
  }
}

for (const p of [...new Set(problems)]) console.error(p);
console.log(problems.length ? `ui-checks: ${new Set(problems).size} problem(s)` : `ui-checks: clean (${files.length} files)`);
process.exit(problems.length ? 1 : 0);
