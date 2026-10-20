import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { formatDate, formatFigure, isoWeek, countNoun } from "@/core/shared/dates";
import { domainForItemType, asDomain } from "@/core/shared/domains";
import { sendInvitationEmail } from "@/core/shared/email";
import { resolveItemUuid } from "@/core/shared/ids";
import { slugify } from "@/core/shared/text";
import { captureError, withErrorCapture } from "@/core/shared/telemetry";
import { canonicalUrl, hostOf, stripUrlMarkers } from "@/core/shared/url";

import { scripted } from "../_support/fake-clients.ts";
import { fakeDb, wrote } from "../_support/fake-db.ts";

test("dates: one format set and the ISO week helper", () => {
  assert.equal(formatDate("2026-03-04"), "Mar 4, 2026");
  assert.equal(formatDate("2026-03-04T10:00:00Z"), "Mar 4, 2026");
  assert.equal(formatDate("2026-03"), "Mar 2026");
  assert.equal(formatDate("garbage"), "garbage");
  assert.equal(formatDate(null), "");
  assert.equal(isoWeek(new Date(2021, 0, 3)), 53);
  assert.equal(isoWeek(new Date(2024, 11, 30)), 1);
  assert.equal(isoWeek(new Date(2026, 5, 15)), 25);
  assert.equal(countNoun(1, "item"), "1 item");
  assert.equal(countNoun(1234, "item"), "1,234 items");
});

test("text: slugs", () => {
  assert.equal(slugify("  Acme & Sons, Ltd.! "), "acme-sons-ltd");
  assert.equal(slugify("x".repeat(80)).length, 40);
});

test("url: the single canonicaliser and hostOf", () => {
  const fixtures: [string, string][] = [
    ["https://eur-lex.europa.eu/eli/reg/2023/1804/oj/eng*", "https://eur-lex.europa.eu/eli/reg/2023/1804/oj/eng"],
    ["https://icapcarbonaction.com/en/ets.*", "https://icapcarbonaction.com/en/ets"],
    ["https://www.consilium.europa.eu/en/policies/fit-for-55/.*", "https://consilium.europa.eu/en/policies/fit-for-55"],
    ["https://www.imo.org", "https://imo.org"],
    ["https://icapcarbonaction.com/", "https://icapcarbonaction.com"],
    ["https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R1805*", "https://eur-lex.europa.eu/legal-content/en/txt/?uri=celex%3a32023r1805"],
  ];
  for (const [polluted, clean] of fixtures) assert.equal(canonicalUrl(polluted), clean.toLowerCase());
  assert.equal(canonicalUrl(null), null);
  assert.equal(stripUrlMarkers("see https://a.test/x* and `https://b.test/y`"), "see https://a.test/x and `https://b.test/y");
  assert.equal(hostOf("https://www.Example.org/path?q=1"), "example.org");
  assert.equal(hostOf("WWW.imo.org"), "imo.org");
  assert.equal(hostOf("not a url"), "");
  assert.equal(hostOf(null), "");
});

test("domains: item_type routing mirrors migration 101 and never coerces an unknown type to 1", () => {
  assert.equal(domainForItemType("regulation"), 1);
  assert.equal(domainForItemType("framework", "research"), 7);
  assert.equal(domainForItemType("framework"), 1);
  assert.equal(domainForItemType("tool", "operational_data"), 3);
  assert.equal(domainForItemType("tool"), 2);
  assert.equal(domainForItemType("initiative", "regulatory"), 1);
  assert.equal(domainForItemType("initiative"), 4);
  assert.equal(domainForItemType("technology"), 2);
  assert.equal(domainForItemType("market_signal"), 4);
  assert.equal(domainForItemType("regional_data"), 3);
  assert.equal(domainForItemType("research_finding"), 7);
  assert.equal(domainForItemType("mystery"), null);
  assert.equal(domainForItemType(null), null);
  assert.equal(asDomain(7), 7);
  assert.equal(asDomain(8), null);
  assert.equal(asDomain("1"), null);
});

test("ids: resolveItemUuid passes a uuid through, looks a legacy id up, and a failed read throws", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const untouched = fakeDb();
  assert.equal(await resolveItemUuid(untouched.db, id), id);
  assert.equal(untouched.calls.length, 0);
  assert.equal(await resolveItemUuid(fakeDb(() => ({ data: { id } })).db, "o3"), id);
  assert.equal(await resolveItemUuid(fakeDb(() => ({ data: null })).db, "o3"), null);
  await assert.rejects(resolveItemUuid(fakeDb(() => ({ error: { message: "down" } })).db, "o3"), /read failed: down/);
});

test("email: the seam is honest that no provider is configured", async () => {
  assert.deepEqual(await sendInvitationEmail({ to: "a@b.test", inviteUrl: "https://x.test", proposedRole: "member" }), { delivered: false, configured: false, reason: "No email provider is configured on this deployment." });
});

test("telemetry: captureError stores no PII, dedups on the stack hash and never throws", async () => {
  const stored = fakeDb();
  await captureError({ side: "server", route: "/api/x", error: new Error("lookup failed for ada@example.test at row 42"), userScope: "11111111-1111-4111-8111-111111111111" }, stored.db);
  const row = wrote(stored.calls, "error_events", "insert")[0]?.payload as Record<string, unknown>;
  assert.equal(String(row.message).includes("ada@example.test"), false);
  assert.match(String(row.message), /\[email\]/);
  assert.equal(String(row.stack_excerpt).includes("ada@example.test"), false);
  assert.equal(row.user_scope, "11111111-1111-4111-8111-111111111111");
  assert.equal(String(row.stack_hash).length, 64);

  let selects = 0;
  const dup = fakeDb((c) => (c.op === "insert" ? { error: { message: "dup", code: "23505" } } : c.op === "select" ? ((selects += 1), { data: { id: "e1", count: 4 } }) : undefined));
  await captureError({ side: "client", route: "/p", error: "string error" }, dup.db);
  assert.equal(selects, 1);
  assert.equal((wrote(dup.calls, "error_events", "update")[0]?.payload as { count: number }).count, 5);

  await assert.doesNotReject(captureError({ side: "server", route: "/x", error: new Error("e") }, fakeDb(() => ({ error: { message: "boom" } })).db));
  const exploding = { from() { throw new Error("client exploded"); } } as never;
  await assert.doesNotReject(captureError({ side: "server", route: "/x", error: new Error("e") }, exploding));
  const hashOf = async (side: "server" | "client", message: string) => {
    const db = fakeDb();
    await captureError({ side, route: "/x", error: new Error(message) }, db.db);
    return String((wrote(db.calls, "error_events", "insert")[0]?.payload as Record<string, unknown>).stack_hash);
  };
  assert.equal(await hashOf("server", "row 1 failed"), await hashOf("server", "row 99 failed"), "numbers do not split a group");
  assert.notEqual(await hashOf("server", "a"), await hashOf("client", "a"));
});

test("withErrorCapture re-raises after capturing; with no service client the first capture says so once per process, never throws and never repeats the line", async () => {
  scripted.service = null;
  const warned = mock.method(globalThis.console, "warn", () => {});
  try {
    const wrapped = withErrorCapture("/t", async () => {
      throw new Error("handler failed");
    });
    await assert.rejects(wrapped(new Request("https://x.test"), undefined), /handler failed/);
    for (let i = 0; i < 600; i += 1) await captureError({ side: "server", route: "/api/x", error: new Error("boom") });
  } finally {
    warned.mock.restore();
  }
  const lines = warned.mock.calls.map((c) => c.arguments);
  assert.equal(lines.filter((l) => String(l[0]).includes("error_events is unavailable")).length, 1);
});

test("IMP-014: with RESEND_API_KEY and INVITATION_FROM_EMAIL the invitation goes through Resend as one HTTPS call; a refusal, a network failure and a half-set configuration are each stated, never a silent success", async () => {
  const env = { RESEND_API_KEY: "re_test", INVITATION_FROM_EMAIL: "invites@mail.example.test" };
  const sent: { url: string; init: RequestInit }[] = [];
  const answer = (status: number) => (async (url: string, init: RequestInit) => (sent.push({ url, init }), new Response("{}", { status }))) as unknown as typeof fetch;
  const mail = { to: "pat@example.test", inviteUrl: "https://app.example.test/invitations/t0", orgName: "Org <A>", proposedRole: "member" };
  assert.deepEqual(await sendInvitationEmail(mail, { env, fetchImpl: answer(200) }), { delivered: true, configured: true });
  assert.equal(sent[0]?.url, "https://api.resend.com/emails");
  const body = JSON.parse(String(sent[0]?.init.body)) as { from: string; to: string[]; html: string; text: string };
  assert.deepEqual([body.from, body.to], ["invites@mail.example.test", ["pat@example.test"]]);
  assert.match(body.text, /https:\/\/app\.example\.test\/invitations\/t0/);
  assert.match(body.html, /Org &lt;A&gt;/, "the organisation name is escaped");
  assert.equal((sent[0]?.init.headers as Record<string, string>).authorization, "Bearer re_test");
  assert.deepEqual(await sendInvitationEmail(mail, { env, fetchImpl: answer(422) }), { delivered: false, configured: true, reason: "The e-mail provider answered HTTP 422." });
  const down = await sendInvitationEmail(mail, { env, fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  assert.deepEqual([down.delivered, down.configured, down.reason], [false, true, "The e-mail provider could not be reached: offline"]);
  for (const half of [{ RESEND_API_KEY: "re_test" }, { INVITATION_FROM_EMAIL: "invites@mail.example.test" }, {}]) assert.deepEqual(await sendInvitationEmail(mail, { env: half, fetchImpl: answer(200) }), { delivered: false, configured: false, reason: "No email provider is configured on this deployment." });
  assert.equal(sent.length, 2, "nothing was sent for a half-set configuration");
});

test("formatFigure: a computed float prints without its noise, and keeps real precision and separators", () => {
  assert.equal(formatFigure(13.209999999999999), "13.21");
  assert.equal(formatFigure(16.119999999999997), "16.12");
  assert.equal(formatFigure(3.5300000000000002), "3.53");
  assert.equal(formatFigure(1278.350000000001), "1,278.35");
  assert.equal(formatFigure(0.000125), "0.000125");
  assert.equal(formatFigure(60000), "60,000");
});
