// Ported from old_repo/scripts/producers/registry/load-registry.mjs (lines 1-144)
// Ported from old_repo/scripts/producers/registry/run-registered.mjs (lines 1-69)
// The producer registry: entries validated at load (closed field set, kill switch name, entity id shape), selected by name or in_all, run in-process in order,
// stopping at the first failure. The catalog of specs is passed in (core never imports a feature); an entry with no spec, or one that disagrees with its spec, is refused.
import { z } from "zod";

import { assertEntityId } from "@/core/entities";
import { runResult, type RunResult } from "@/core/intake/result";

import raw from "./data/registry.json";
import type { ProducerDeps } from "./deps";
import { runProducer, type ProducerSpec, type RunInput } from "./runner";

const entry = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    domain_table: z.string().regex(/^[a-z][a-z0-9_]*$/),
    source: z.string().min(1),
    licence: z.string().trim().min(1),
    dry_capable: z.literal(true),
    enabled_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/).nullable(),
    in_all: z.boolean(),
    accepts_since: z.boolean().optional(),
    entity_id: z.string().optional(),
  })
  .strict();
export type RegistryEntry = z.infer<typeof entry>;

export type Catalog = Readonly<Record<string, ProducerSpec>>;

/** Validate every entry; refuse duplicates, a malformed entity id, and (given a catalog) an entry whose spec is missing or disagrees on table or kill switch. */
export function loadProducerRegistry(catalog?: Catalog, entries: unknown = raw): readonly RegistryEntry[] {
  const parsed = z.array(entry).parse(entries);
  const seen = new Set<string>();
  for (const e of parsed) {
    if (seen.has(e.name)) throw new Error(`producer registry: duplicate name "${e.name}"`);
    seen.add(e.name);
    if (e.entity_id !== undefined) {
      try {
        assertEntityId(e.entity_id);
      } catch (err) {
        throw new Error(`producer registry: ${e.name}: entity_id must be a well-formed entity id cl:<kind>:<16 hex> (${(err as Error).message})`);
      }
    }
    if (catalog) {
      const spec = catalog[e.name];
      if (!spec) throw new Error(`producer registry: ${e.name}: no producer spec of that name in the catalog`);
      if (spec.table !== e.domain_table) throw new Error(`producer registry: ${e.name}: domain_table ${e.domain_table} disagrees with its spec (${spec.table})`);
      if (spec.killSwitchEnv !== e.enabled_env) throw new Error(`producer registry: ${e.name}: enabled_env ${e.enabled_env} disagrees with its spec (${spec.killSwitchEnv})`);
    }
  }
  return Object.freeze(parsed);
}

/**
 * Which entries a dispatch runs. producer "all" runs the in_all entries; "registry" runs the entry named by `only` (even when not in_all), or the in_all entries
 * when `only` is empty. Any other value belongs to a non-registry step and selects nothing.
 */
export function selectRuns(entries: readonly RegistryEntry[], sel: { producer: string; only?: string | undefined }): RegistryEntry[] {
  const only = sel.only ?? "";
  if (only && sel.producer !== "registry") throw new Error(`dispatch: only applies when producer is "registry" (producer is "${sel.producer}")`);
  if (sel.producer === "all" || (sel.producer === "registry" && !only)) return entries.filter((e) => e.in_all);
  if (sel.producer === "registry") {
    const hit = entries.find((e) => e.name === only);
    if (!hit) throw new Error(`dispatch: unknown registry producer "${only}" (known: ${entries.map((e) => e.name).join(", ")})`);
    return [hit];
  }
  return [];
}

/**
 * Run the selected producers in registry order, in-process, stopping at the first failed one. The entity a run stamps comes from its registry entry ONLY: an
 * ambient entity in the caller's environment never reaches an entry that declares none. Dry unless `mode` is "apply".
 */
export async function runRegistered(deps: ProducerDeps, o: { catalog: Catalog; producer?: string; only?: string | undefined; mode?: "dry" | "apply"; since?: string | null; entries?: readonly RegistryEntry[]; input?: Pick<RunInput, "text" | "orgId"> }): Promise<RunResult> {
  let runs: RegistryEntry[];
  try {
    runs = selectRuns(o.entries ?? loadProducerRegistry(o.catalog), { producer: o.producer ?? "all", only: o.only });
  } catch (e) {
    return runResult("failed", { selected: 0 }, [(e as Error).message]);
  }
  const counts: Record<string, number> = { selected: runs.length, ran: 0 };
  const notes: string[] = [`registry producers: mode=${o.mode ?? "dry"} selected=${runs.map((r) => r.name).join(",") || "(none)"}`];
  let outcome: RunResult["outcome"] = "ok";
  for (const e of runs) {
    const spec = (o.catalog as Record<string, ProducerSpec>)[e.name] as ProducerSpec;
    const res = await runProducer(deps, { spec, dry: o.mode !== "apply", since: e.accepts_since ? (o.since ?? null) : null, entityId: e.entity_id ?? null, ...(o.input ?? {}) });
    counts.ran = (counts.ran ?? 0) + 1;
    counts[`${e.name}.parsed`] = res.counts.parsed ?? 0;
    notes.push(...res.notes);
    if (res.outcome === "failed") {
      // The ledger names a failed run by its first note: the failing producer's own notes lead, the header and the earlier producers' notes follow.
      return runResult("failed", counts, [...res.notes, `registry producer ${e.name} failed; stopping`, ...notes.slice(0, notes.length - res.notes.length)]);
    }
    if (res.outcome === "partial") outcome = "partial";
  }
  return runResult(outcome, counts, notes);
}
