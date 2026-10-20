// New in R2e (M3). Domain ownership, performed and recorded: the member publishes a DNS TXT record at `_caros-ledge.<domain>` whose value is derived from their id, the domain and the server-only organisation salt; the route reads it.
// A name on a list proves nothing (mailinator.com was "verified"); control of a domain's DNS does, and a free-mail provider's domain can never carry the record. The resolver is called as `dns.resolveTxt` on the default export of node:dns/promises, so a test replaces that one property and no test reaches the network.
import { createHmac } from "node:crypto";
import dns from "node:dns/promises";

const PROOF_LABEL = "_caros-ledge";
const VALUE_PREFIX = "caros-ledge-verification=";
/** How long a lookup may take before it is a failed lookup (a retry), not an absent record. */
const LOOKUP_MS = 5000;

const tokenOf = (userId: string, domain: string, salt: string): string => createHmac("sha256", salt).update(`verify:${userId}:${domain.toLowerCase()}`, "utf8").digest("hex").slice(0, 32);

/** The record the member publishes: its host and its value. */
export const proofRecord = (userId: string, domain: string, salt: string): { host: string; value: string } => ({ host: `${PROOF_LABEL}.${domain.toLowerCase()}`, value: `${VALUE_PREFIX}${tokenOf(userId, domain, salt)}` });

export type ProofResult = { ok: true; evidence: { host: string; checked_at: string } } | { ok: false; reason: "not_found" | "lookup_failed" };

/** Read the record. A name with no such record (ENOTFOUND, ENODATA) is a definite absence; any other failure, a timeout included, is a failed lookup. */
export async function checkDomainProof(userId: string, domain: string, salt: string, now: () => Date): Promise<ProofResult> {
  const want = proofRecord(userId, domain, salt);
  let records: string[][];
  try {
    records = await Promise.race([dns.resolveTxt(want.host), new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("lookup timed out"), { code: "ETIMEOUT" })), LOOKUP_MS).unref())]);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return { ok: false, reason: code === "ENOTFOUND" || code === "ENODATA" ? "not_found" : "lookup_failed" };
  }
  return records.some((parts) => parts.join("") === want.value) ? { ok: true, evidence: { host: want.host, checked_at: now().toISOString() } } : { ok: false, reason: "not_found" };
}
