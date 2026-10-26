// FIX-P1-1: the seed pages of the coupling vocabulary are captured by captureCited, which stores a page only when classifyBody calls its text real content. The classifier's EUR-Lex rule (an interface shell is portal chrome with no instrument body) was given no host
// by the capture path, so it fired on every europa.eu page: all nine ec.europa.eu seed pages came back `capture_thin` from the direct tier and from the browser tier (production run a09ec94a). Each fetch site now states the host and path it fetched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_CLASS, bodyOpts, classifyBody } from "@/core/fetch/classify-body";
import { captureCited } from "@/core/turn/stages/capture";

import { fixture } from "../integration/world.ts";

/** What a Commission page reads as: the cookie banner, the EU site header and its language selector (the words the EUR-Lex portal rule looks for), then the page's own text. */
const CHROME = "Skip to main content This site uses cookies. Visit our cookies policy page or click the link in any footer for more information and to change your preferences. Accept all cookies Accept only essential cookies An official website of the European Union All official European Union website addresses are in the europa.eu domain. See all EU institutions and bodies Select your language Close EU official languages bg български es español cs čeština da dansk de Deutsch en English fr français";
const QUOTE = "The potential for increasing the modal share of inland waterway transport is considerable.";
const BODY = `${CHROME} ${"Inland waterways carry freight between ports and the hinterland on rivers and canals across the Union. ".repeat(40)}${QUOTE}`;
const EC = "https://transport.ec.europa.eu/transport-modes/inland-waterways_en";
const EURLEX = "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R9998";

test("a Commission page is content, not an EUR-Lex interface shell: the seed capture stores it from the direct tier", async () => {
  const f = fixture({ routes: { [EC]: () => new Response(`<html><body><p>${BODY}</p></body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) } });
  const r = await captureCited(f.d, [{ url: EC, title: "Inland waterways" }], true);
  assert.equal(r.counts.captured, 1, r.notes.join("|"));
  assert.ok(f.db.rows("agent_run_searches").some((s) => s.result_url === EC && String(s.result_content).includes(QUOTE) && s.capture_channel === "direct"));
});

test("the same chrome on the EUR-Lex portal with no instrument body is still an interface shell; with a body it is content", () => {
  assert.equal(classifyBody(BODY, bodyOpts(EURLEX, { status: 200 })).class, BODY_CLASS.INTERFACE_SHELL);
  assert.equal(classifyBody(`${BODY} Article 1 Subject matter`, bodyOpts(EURLEX, { status: 200 })).class, BODY_CLASS.OK);
  assert.equal(classifyBody(BODY, bodyOpts(EC, { status: 200 })).class, BODY_CLASS.OK);
});

test("a page no tier could store says why for each tier it tried, so the note names the browser tier's outcome and not only the direct tier's", async () => {
  const wall = "Skip to main content. Please enable JavaScript to view this site.";
  const f = fixture({ routes: { [EC]: () => new Response(`<html><body><p>${wall}</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } }) } });
  const r = await captureCited(f.d, [{ url: EC, title: "Inland waterways" }], true);
  assert.equal(r.counts.failed, 1);
  assert.match(r.notes.join("|"), /direct: capture_thin; browser: /);
});
