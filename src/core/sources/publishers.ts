// New in R2c: no old counterpart (the old tree had no way to read an instrument at a second official publisher when the first refused; D:49, the collection-under-honest-identity measurement).
// The substitute-publisher table: an identifier scheme maps to an ordered list of official publishers, each with a URL template and a channel kind. The table is data (data/publishers-by-scheme.json), validated at load; every publisher
// carries the terms page that was read and the date. An entry marked unverified is never used (the gate fails closed on it), and a channel that needs a credential is used only when its env variable is set.
import { z } from "zod";

import { parseOjReference } from "@/core/fetch/capture";
import { hostOf } from "@/core/shared";

import raw from "./data/publishers-by-scheme.json";

const REUSE = z.enum(["open_government", "eu_reuse", "public_domain", "licensed", "unknown", "prohibited"]);
const credential = z.object({ env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)).min(1), registration: z.string(), fields: z.string(), free: z.boolean(), terms: z.string() }).nullable();
const publisher = z
  .object({
    name: z.string().min(1),
    host: z.string().min(3),
    jurisdiction: z.string().min(2),
    reuse: REUSE,
    status: z.enum(["verified", "unverified"]),
    reason: z.string().optional(),
    terms: z.object({ url: z.string().url(), readAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), says: z.string().min(10) }).nullable(),
    credential,
    attribution: z.string().min(3),
  })
  .superRefine((p, ctx) => {
    if (p.status === "verified" && !p.terms) ctx.addIssue({ code: "custom", message: `${p.name}: a verified publisher carries the terms page it was verified against and the date` });
    if (p.status === "unverified" && !p.reason) ctx.addIssue({ code: "custom", message: `${p.name}: an unverified publisher says what was not verified` });
  });
const entry = z.object({ publisher: z.string(), kind: z.enum(["template", "federal_register", "unsupported"]), channel: z.enum(["api", "direct"]), template: z.string(), headers: z.record(z.string(), z.string()).optional(), credentialQuery: z.boolean().optional(), status: z.literal("unverified").optional(), reason: z.string().optional() });
const schema = z
  .object({ _comment: z.string(), publishers: z.record(z.string(), publisher), bySchema: z.record(z.string(), z.array(entry).min(1)) })
  .superRefine((t, ctx) => {
    for (const [scheme, list] of Object.entries(t.bySchema)) for (const e of list) if (!t.publishers[e.publisher]) ctx.addIssue({ code: "custom", message: `${scheme}: unknown publisher ${e.publisher}` });
  });
const TABLE = schema.parse(raw);

export type PublisherEntry = z.infer<typeof entry> & { id: string; publisherName: string; host: string; reuse: z.infer<typeof REUSE>; attribution: string; termsUrl: string | null };
export interface Identifier {
  scheme: string;
  id: string;
  parts: Record<string, string>;
}

const UK_TYPES = "ukpga|uksi|ukla|ukcm|ukmo|ukdsi|asp|asc|anaw|wsi|nisr|nia|nisi|mwa|ssi|apni|aosp|aep|ukppa|mnia";
/** The identifiers a URL (and, when given, the item's own identifier text) names. A scheme is found only when the evidence is explicit; nothing is guessed. */
export function identifiersOf(url: string, text?: string | null): Identifier[] {
  const hay = `${decodeURIComponent(url.replace(/%(?![0-9a-f]{2})/gi, "%25"))} ${text ?? ""}`;
  const out: Identifier[] = [];
  const add = (scheme: string, id: string, parts: Record<string, string> = {}) => {
    if (!out.some((o) => o.scheme === scheme && o.id === id)) out.push({ scheme, id, parts });
  };
  const celex = /CELEX[:\s]*([0-9]{5}[A-Z]{1,2}[0-9]{4}(?:\([0-9]+\))?)/i.exec(hay)?.[1] ?? /\/celex\/([0-9]{5}[A-Z]{1,2}[0-9]{4})/i.exec(hay)?.[1];
  if (celex) add("celex", celex.toUpperCase());
  const oj = parseOjReference(url);
  if (oj) add("oj", `${oj.series}_${oj.year}_${oj.issue}`, { code: oj.series === "L" ? "JOL" : "JOC", year: oj.year, issue: oj.issue, edition: oj.edition ?? "R" });
  const eli = /data\.europa\.eu\/eli\/([a-z]+\/\d{4}\/\d+[A-Za-z0-9/_-]*)/i.exec(hay)?.[1];
  if (eli) add("eli", eli);
  const si = /\bS\.?\s?I\.?\s*(\d{4})\s*\/\s*(\d+)\b/i.exec(hay);
  const uk = new RegExp(`legislation\\.gov\\.uk/((?:${UK_TYPES})/\\d{4}/\\d+)`, "i").exec(hay)?.[1] ?? (si ? `uksi/${si[1]}/${si[2]}` : undefined);
  if (uk) add("uk_legislation", uk.toLowerCase());
  const fr = /federalregister\.gov\/documents\/\d{4}\/\d{2}\/\d{2}\/([A-Z]?\d{1,4}-\d{3,6})\//i.exec(hay)?.[1] ?? /\bFR\s*Doc(?:ument)?\.?\s*(?:No\.?|Number)?\s*:?\s*([A-Z]?\d{1,4}-\d{3,6})\b/i.exec(hay)?.[1];
  if (fr) add("federal_register", fr);
  const cfr = /\b(\d{1,2})\s*C\.?F\.?R\.?\s*(?:Part\s*)?(\d{1,4})\b/i.exec(hay) ?? /ecfr\.gov\/[^\s]*?title-(\d{1,2})[^\s]*?part-(\d{1,4})/i.exec(hay);
  if (cfr) add("cfr", `${cfr[1]} CFR ${cfr[2]}`, { title: cfr[1] as string, part: cfr[2] as string });
  const pl = /\bPub(?:lic)?\.?\s*L(?:aw)?\.?\s*(?:No\.?\s*)?(\d{2,3})\s*[-–]\s*(\d{1,4})\b/i.exec(hay);
  if (pl) add("public_law", `${pl[1]}-${pl[2]}`, { congress: pl[1] as string, number: pl[2] as string });
  const reg = /\b([A-Z]{2,}(?:-[A-Z]{1,6})*-\d{4}-\d{4}-\d{4})\b/.exec(hay)?.[1];
  if (reg) add("regulations_gov_document", reg);
  const imo = /\b((?:MEPC|MSC|A|FAL|LEG|TC)\.\d+\(\d+\)|(?:MEPC|MSC|FAL)\.\d+\/Circ\.\d+)/i.exec(hay)?.[1];
  if (imo) add("imo_resolution", imo.toUpperCase());
  const icao = /\bICAO\s+Doc(?:ument)?\.?\s*(\d{4})\b/i.exec(hay)?.[1];
  if (icao) add("icao_document", icao);
  return out;
}

const fill = (template: string, vars: Record<string, string>): string | null => {
  let missing = false;
  const s = template.replace(/\{(\w+)\}/g, (_, k: string) => ((vars[k] ?? (missing = true)) as string));
  return missing ? null : s;
};
export interface SubstituteChoice {
  entry: PublisherEntry;
  url: string;
  headers: Record<string, string>;
}
export interface SubstituteSkip {
  publisher: string;
  scheme: string;
  why: string;
}
/**
 * The usable substitute publishers for a set of identifiers, in the table's order, and the entries skipped with the reason (unverified, unsupported, a credential not set, the refusing source's own host). The skip list is returned,
 * never dropped, so the exhaustion record can name what was not tried. `refusingHost` is never its own substitute.
 */
export function substituteCandidates(ids: readonly Identifier[], opts: { env: Record<string, string | undefined>; today: string; refusingHost?: string | null }): { use: SubstituteChoice[]; skipped: SubstituteSkip[] } {
  const use: SubstituteChoice[] = [];
  const skipped: SubstituteSkip[] = [];
  for (const idf of ids) {
    for (const e of TABLE.bySchema[idf.scheme] ?? []) {
      const p = TABLE.publishers[e.publisher];
      if (!p) continue;
      const skip = (why: string) => skipped.push({ publisher: e.publisher, scheme: idf.scheme, why });
      if (p.status !== "verified" || e.status === "unverified") skip(`unverified: ${e.reason ?? p.reason ?? "terms not read"}`);
      else if (e.kind === "unsupported") skip("no verified URL template for this identifier");
      else if (opts.refusingHost && hostOf(p.host) === opts.refusingHost) skip("the refusing source's own host is not a substitute");
      else {
        const missingEnv = p.credential?.env.filter((n) => !opts.env[n]) ?? [];
        const key = p.credential ? opts.env[p.credential.env[0] as string] : undefined;
        if (missingEnv.length) skip(`credential not set: ${missingEnv.join(", ")} (registration ${p.credential?.registration}, free: ${p.credential?.free})`);
        else {
          const url = fill(e.template, { id: idf.id, today: opts.today, key: key ? encodeURIComponent(key) : "", ...idf.parts });
          if (!url) skip(`the identifier does not carry every part the template needs`);
          else use.push({ entry: { ...e, id: e.publisher, publisherName: p.name, host: p.host, reuse: p.reuse, attribution: p.attribution, termsUrl: p.terms?.url ?? null }, url, headers: e.headers ?? {} });
        }
      }
    }
  }
  return { use, skipped };
}

/** Every credential-needing channel in the table, for the interface-gap report: which variable, where to register, whether it is free. */
export const credentialGaps = (): Array<{ publisher: string; env: string[]; registration: string; fields: string; free: boolean; terms: string; status: string }> =>
  Object.entries(TABLE.publishers).flatMap(([id, p]) => (p.credential ? [{ publisher: id, status: p.status, ...p.credential }] : []));
export const publisherTable = TABLE;
