// BTN-1: the operator look ruling of 2026-10-26 for every button. The look is written once (src/ui/base.css .cl-btn, tokens in theme.css) and every button reads it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Button, buttonClass } from "@/ui/Button";

const ROOT = process.env.BTN_ROOT ?? process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** The declarations of the rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};
function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) yield* sources(rel);
    else if (/\.(tsx?|css)$/.test(name)) yield rel;
  }
}

const base = read("src/ui/base.css");
const theme = read("src/ui/theme.css");

test("BTN-1: .cl-btn carries the four-layer shadow, each layer read from a token", () => {
  const shadow = /box-shadow:\s*([^;]+);/.exec(rule(base, ".cl-btn"))?.[1] ?? "";
  assert.deepEqual(
    shadow.split(/,\s*(?![^(]*\))/).map((l) => l.trim()),
    ["inset 0 1px 0 var(--btn-hi)", "inset 0 -2px 0 var(--btn-shade)", "0 1px 2px var(--btn-contact)", "0 8px 24px -6px var(--b-glow)"],
  );
});

test("BTN-1: the tokens exist once in theme.css, with a dark edge, and the glow is the accent with alpha", () => {
  for (const t of ["--btn-gradient-from", "--btn-gradient-to", "--btn-glow", "--btn-hi", "--btn-shade", "--btn-contact", "--btn-press", "--btn-danger-glow"]) {
    assert.equal((theme.match(new RegExp(`^[ ]*${t}:`, "gm")) ?? []).length, 1, `${t} is defined once on :root`);
  }
  assert.match(theme, /--btn-glow:\s*color-mix\(in srgb, var\(--brand\) 60%, transparent\)/);
  assert.match(theme, /--btn-gradient-from:\s*color-mix\(in srgb, var\(--brand\)/);
  assert.match(theme, /:root\[data-theme="dark"\][^{]*\{[^}]*--btn-hi:/);
});

test("BTN-1: primary and danger are a vertical gradient with their own glow; secondary and ghost have none", () => {
  assert.match(rule(base, ".cl-btn--primary, .cl-btn--danger"), /background:\s*linear-gradient\(to bottom, var\(--b-from\), var\(--b-to\)\)/);
  assert.match(rule(base, ".cl-btn--primary"), /--b-glow:\s*var\(--btn-glow\)/);
  assert.match(rule(base, ".cl-btn--danger"), /--b-glow:\s*var\(--btn-danger-glow\)/);
  assert.doesNotMatch(rule(base, ".cl-btn--secondary") + rule(base, ".cl-btn--ghost"), /--b-glow/);
  assert.match(rule(base, ".cl-btn"), /--b-glow:\s*transparent/);
});

test("BTN-1: pressed state translates 1px with the inner shadow; disabled has no glow and no press; nothing animates", () => {
  const active = rule(base, ".cl-btn:active:not(:disabled)");
  assert.match(active, /translate:\s*0 1px/);
  assert.match(active, /box-shadow:\s*inset 0 2px 4px var\(--btn-press\)/);
  assert.match(rule(base, ".cl-btn:disabled"), /--b-glow:\s*transparent/);
  const block = base.slice(base.indexOf("/* ── buttons"), base.indexOf("@keyframes cl-spin"));
  assert.doesNotMatch(block, /transition/, "the press is immediate (Doherty); a transition would delay it");
});

test("BTN-1: Button and buttonClass render the primitive's classes; loading disables and announces busy", () => {
  assert.equal(buttonClass("primary", "sm", "x", true), "cl-btn cl-btn--primary cl-btn--sm cl-btn--dashed x");
  const html = renderToStaticMarkup(createElement(Button, { variant: "primary", loading: true }, "Go"));
  assert.match(html, /class="cl-btn cl-btn--primary cl-btn--md"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /aria-busy="true"/);
  assert.match(renderToStaticMarkup(createElement(Button, null, "Go")), /class="cl-btn cl-btn--secondary cl-btn--md"/);
});

test("BTN-1: no second owner of a button look remains in src", () => {
  const retired = [/cl-action-btn/, /cl-command-bar-ask-submit/, /\bscopeButton\b/, /styles\.(?:primary|secondary)\b/, /\bActionButton\b/];
  const hits: string[] = [];
  for (const f of sources("src")) {
    const text = read(f);
    for (const re of retired) if (re.test(text)) hits.push(`${f}: ${re}`);
    if (f.endsWith(".css") && f !== "src/ui/base.css" && /\.cl-btn\b/.test(text)) hits.push(`${f}: restyles .cl-btn`);
    if (f.endsWith(".tsx") && f !== "src/ui/Button.tsx" && /className=(?:"|\{`)cl-btn/.test(text)) hits.push(`${f}: writes cl-btn by hand`);
  }
  assert.deepEqual(hits, []);
});
