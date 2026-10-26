// The one host-relation rule of the claim ledger, in code. The database decides whether a claim's source may stand on a capture (ledger_attribution, migration 0074): the source's host and the capture's host must be
// EQUAL or one a SUBDOMAIN of the other, after ledger_host_of (scheme required, user info, port and a leading `www.` dropped, lower-cased). Every caller that chooses a source for a capture asks this module, so no code proposes
// a source the database then refuses (HEAL-1: a claim on transport.ec.europa.eu was given the source finance.ec.europa.eu because both are the same institution).
// One difference from the SQL, stated: the SQL compares with LIKE, where `_` and `%` in a host are wildcards; a host name has neither, so the literal suffix test here is the same relation.

/** ledger_host_of: the host of an absolute URL as the ledger compares it; empty when the text has no scheme and host. */
export function ledgerHostOf(url: string | null | undefined): string {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(String(url ?? ""));
  return (m?.[1] ?? "").toLowerCase().replace(/^[^@]*@/, "").replace(/:[0-9]*$/, "").replace(/^www\./, "");
}

/** ledger_hosts_related: both hosts present, and equal or one a subdomain of the other. */
export function hostsRelated(a: string, b: string): boolean {
  return a !== "" && b !== "" && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
}

/** The dot-suffixes of a host, longest first, without the host itself: a.b.c gives b.c, c. */
export function hostAncestors(host: string): string[] {
  const out: string[] = [];
  for (let i = host.indexOf("."); i !== -1; i = host.indexOf(".", i + 1)) out.push(host.slice(i + 1));
  return out;
}
