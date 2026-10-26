// HEAL-1b: the one host-relation rule. A source may stand on a capture only when the database accepts the pair (ledger_attribution, migration 0074): equal hosts, or one a subdomain of the other. The resolver every caller uses names only such a source.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hostAncestors, hostsRelated, ledgerHostOf } from "@/core/sources";
import { buildResolver } from "@/core/sources/institution";

test("ledger_host_of and ledger_hosts_related as the database has them: scheme required, user info, port and www dropped; equal or subdomain either way, never a sibling or a look-alike suffix", () => {
  assert.equal(ledgerHostOf("https://User@WWW.Transport.EC.Europa.eu:8443/a?b#c"), "transport.ec.europa.eu");
  assert.equal(ledgerHostOf("transport.ec.europa.eu/a"), "", "no scheme, no host (the SQL substring finds none)");
  assert.equal(ledgerHostOf(null), "");
  assert.deepEqual(hostAncestors("a.b.c"), ["b.c", "c"]);
  assert.ok(hostsRelated("ec.europa.eu", "ec.europa.eu"));
  assert.ok(hostsRelated("transport.ec.europa.eu", "ec.europa.eu") && hostsRelated("ec.europa.eu", "transport.ec.europa.eu"));
  assert.ok(!hostsRelated("transport.ec.europa.eu", "finance.ec.europa.eu"), "two subdomains of one institution are not related (the HEAL-1 production mismatch)");
  assert.ok(!hostsRelated("notec.europa.eu", "ec.europa.eu") && !hostsRelated("", "") && !hostsRelated("a.eu", ""));
});

const row = (id: string, url: string, base_tier: number, extra: Record<string, unknown> = {}) => ({ id, url, base_tier, ...extra });
test("HEAL-1b: the resolver names a source the database accepts: the exact host first (an override row before the others), then the nearest registered ancestor, then a registered subdomain; a sibling is never chosen", () => {
  const r = buildResolver([
    row("fin", "https://finance.ec.europa.eu/", 2),
    row("ec", "https://ec.europa.eu/commission/presscorner/home/en", 3),
    row("tr", "https://transport.ec.europa.eu/transport-modes", 2),
    row("tr-o", "https://www.transport.ec.europa.eu/other", 4, { tier_override: 1 }),
    row("sub", "https://data.example.org/x", 5),
  ]);
  assert.deepEqual(r.resolveSpan("https://transport.ec.europa.eu/page"), { tier: 1, sourceId: "tr-o" }, "exact host, the override row first, tier_override is the tier");
  assert.deepEqual(r.resolveSpan("https://climate.ec.europa.eu/page"), { tier: 3, sourceId: "ec" }, "the registered ancestor ec.europa.eu, never the sibling finance.ec.europa.eu");
  assert.ok(["fin", "ec", "tr", "tr-o"].includes(r.resolveSpan("https://europa.eu/p").sourceId ?? ""), "a registered subdomain is related to its parent, the last choice");
  assert.deepEqual(r.resolveSpan("https://sibling.ec.europa.eu.example.com/p"), { tier: null, sourceId: null }, "a look-alike suffix is no relation");
  assert.equal(r.resolveSpan("https://example.org/p").sourceId, "sub", "a registered subdomain is related, the last choice");
  assert.deepEqual(r.resolveSpan("https://unknown.example.com/p"), { tier: null, sourceId: null });
  for (const url of ["https://climate.ec.europa.eu/page", "https://transport.ec.europa.eu/page", "https://example.org/p"]) {
    const hit = r.resolveSpan(url);
    const src = [{ id: "ec", u: "https://ec.europa.eu/" }, { id: "tr-o", u: "https://transport.ec.europa.eu/" }, { id: "sub", u: "https://data.example.org/" }].find((s) => s.id === hit.sourceId);
    assert.ok(src && hostsRelated(ledgerHostOf(src.u), ledgerHostOf(url)), `${url} resolved to a related source`);
  }
});
