// Ported from old_repo/src/lib/contracts/source-licence.mjs (lines 1-446)
import { z } from "zod";

import raw from "./data/source-licences.json";

const redistribution = z.object({ code: z.string(), label: z.string(), embeddable: z.boolean(), order: z.number() });
const licence = z.object({
  key: z.string(),
  name: z.string(),
  redistribution: z.string(),
  licence: z.string().nullable().optional(),
  attribution: z.string().nullable(),
  url: z.string().nullable().optional(),
  verifiedOn: z.string().optional(),
  askWho: z.string().optional(),
  askWhat: z.string().optional(),
  blocker: z.string().optional(),
  substitute: z.string().nullable().optional(),
  /** The sentence of the publisher's own terms that grants or withholds reuse, verbatim, and the day it was read there (R2f F9). */
  quote: z.string().min(10).optional(),
  termsReadOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** The domains a prohibited verdict bars collecting from at all: the fetch guard refuses them as licence_forbids before robots.txt (R2f F8). */
  hosts: z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1).optional(),
  note: z.string().optional(),
});
export type SourceLicence = z.infer<typeof licence>;

const file = z
  .object({ redistribution: z.record(z.string(), redistribution), licences: z.record(z.string(), licence) })
  .superRefine((f, ctx) => {
    for (const [key, l] of Object.entries(f.licences)) {
      if (l.key !== key) ctx.addIssue({ code: "custom", message: `licence ${key} carries key ${l.key}` });
      if (!f.redistribution[l.redistribution]) ctx.addIssue({ code: "custom", message: `licence ${key} has unknown redistribution ${l.redistribution}` });
      if (l.substitute && !f.licences[l.substitute]) ctx.addIssue({ code: "custom", message: `licence ${key} names unregistered substitute ${l.substitute}` });
      if (l.quote && !l.termsReadOn) ctx.addIssue({ code: "custom", message: `licence ${key} quotes its terms without the day they were read (termsReadOn)` });
      if (l.hosts && l.redistribution !== "prohibited") ctx.addIssue({ code: "custom", message: `licence ${key} bars hosts but its verdict is ${l.redistribution}, not prohibited` });
    }
  });

const data = file.parse(raw);

/** The register: verified verdicts per data source. `attribution` ships WITH the data, not in a colophon. */
export const SOURCE_LICENCES: Readonly<Record<string, SourceLicence>> = Object.freeze(data.licences);
export const SOURCE_KEYS: readonly string[] = Object.freeze(Object.keys(SOURCE_LICENCES));
const embeddable = (l: SourceLicence): boolean => data.redistribution[l.redistribution]?.embeddable === true;

/** True only for a registered source whose verdict is embeddable; an unregistered key fails closed. */
export function mayEmbedAsSeed(sourceKey: string): boolean {
  const l = SOURCE_LICENCES[sourceKey];
  return !!l && embeddable(l);
}

/**
 * THE GATE: may this source be embedded as seed data and re-served? Fails closed on an unknown key, and names
 * the substitute (prohibited) or the condition to discharge (conditional) in its refusal.
 */
export function licenceGate(sourceKey: string): { ok: true } | { ok: false; reason: string } {
  const l = SOURCE_LICENCES[sourceKey];
  if (!l) return { ok: false, reason: `unregistered data source "${sourceKey}": add it to the register with its verified terms before seeding` };
  if (embeddable(l)) return { ok: true };
  const sub = l.substitute ? ` Licence-safe substitute: "${l.substitute}".` : "";
  const ask = l.askWhat ? ` To discharge: ask ${l.askWho ?? "the rights holder"}: ${l.askWhat}` : "";
  return { ok: false, reason: `source "${sourceKey}" is ${l.redistribution} for embedding: ${l.blocker ?? l.note ?? "see register"}${sub}${ask}` };
}

/** Register triage for the seed plan: embeddable, conditional or unverified, prohibited. */
function licenceTriage(): { green: string[]; amber: string[]; red: string[] } {
  const t: { green: string[]; amber: string[]; red: string[] } = { green: [], amber: [], red: [] };
  for (const k of SOURCE_KEYS) {
    const r = SOURCE_LICENCES[k]?.redistribution;
    (r === "permitted" ? t.green : r === "prohibited" ? t.red : t.amber).push(k);
  }
  return t;
}

/** Every distinct attribution string for a set of sources, deduplicated and sorted. */
export function attributionsFor(sourceKeys: Iterable<string> | null | undefined): string[] {
  const out = new Set<string>();
  for (const k of sourceKeys ?? []) {
    const a = SOURCE_LICENCES[k]?.attribution;
    if (a) out.add(a);
  }
  return [...out].sort();
}

/** The data_sources seed (idempotent ON CONFLICT DO UPDATE, never delete-then-insert: factors reference these rows). Generated, never hand-written. */
export function renderDataSourceSeedSql(): string {
  const lit = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
  const rows = SOURCE_KEYS.map((k) => {
    const e = SOURCE_LICENCES[k] as SourceLicence;
    const cells = [lit(e.key), lit(e.name), lit(e.redistribution), String(embeddable(e)), lit(e.licence), lit(e.attribution), lit(e.url)];
    cells.push(e.verifiedOn ? `${lit(e.verifiedOn)}::date` : "NULL", lit(e.blocker), lit(e.askWho), lit(e.askWhat), lit(e.substitute));
    return `  (${cells.join(", ")})`;
  }).join(",\n");
  const t = licenceTriage();
  const through = SOURCE_KEYS.map((k) => SOURCE_LICENCES[k]?.verifiedOn).filter(Boolean).sort().at(-1) ?? "unverified";
  return `-- GENERATED by src/core/contracts/source-licence.ts renderDataSourceSeedSql(). DO NOT EDIT BY HAND.
-- Drift-guarded: the guard regenerates this block and byte-compares against the migration.
-- Register verified through ${through}. ${SOURCE_KEYS.length} sources: ${t.green.length} embeddable, ${t.amber.length} conditional/unverified, ${t.red.length} prohibited.
INSERT INTO public.data_sources
  (source_key, name, redistribution, embeddable, licence, attribution, url, verified_on, blocker, ask_who, ask_what, substitute)
VALUES
${rows}
ON CONFLICT (source_key) DO UPDATE SET
  name          = EXCLUDED.name,
  redistribution= EXCLUDED.redistribution,
  embeddable    = EXCLUDED.embeddable,
  licence       = EXCLUDED.licence,
  attribution   = EXCLUDED.attribution,
  url           = EXCLUDED.url,
  verified_on   = EXCLUDED.verified_on,
  blocker       = EXCLUDED.blocker,
  ask_who       = EXCLUDED.ask_who,
  ask_what      = EXCLUDED.ask_what,
  substitute    = EXCLUDED.substitute;`;
}

/**
 * src/core/fetch/licence-hosts.ts: the hosts the register bars collecting from, as an import-free module (the guard is shared with the Edge Function, which imports nothing). GENERATED: scripts/gen/licence-hosts.mjs writes it
 * and tests/r2f/licence.test.ts regenerates and diffs it, so the guard cannot disagree with the register.
 */
export function renderLicenceHostsModule(): string {
  const rows = SOURCE_KEYS.flatMap((k) => (SOURCE_LICENCES[k]?.hosts ?? []).map((host) => `  { host: "${host}", key: "${k}" },`)).join("\n");
  return `// GENERATED by scripts/gen/licence-hosts.mjs from src/core/contracts/source-licence.ts renderLicenceHostsModule(). DO NOT EDIT BY HAND.
// The hosts the licence register bars collecting from (a prohibited verdict that lists \`hosts\`): the fetch guard refuses them as licence_forbids before robots.txt, the hold gate refuses them to every Node fetch, and the capture worker
// records the refusal with the register key. Import-free, because the guard is shared with the Edge Function.
const LICENCE_FORBIDDEN_HOSTS: readonly { host: string; key: string }[] = [
${rows}
];

/** The register key that bars collecting from \`hostname\` (equal to a listed host or a subdomain of it), or null. */
export function licenceForbidsHost(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\\.$/, "");
  for (const f of LICENCE_FORBIDDEN_HOSTS) if (h === f.host || h.endsWith(\`.\${f.host}\`)) return f.key;
  return null;
}
`;
}
