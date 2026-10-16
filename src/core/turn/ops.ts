// Ported from old_repo/scripts/maintenance/lib/cli.mjs (lines 70-108)
// The operator tasks: every runtime entry that is not a stage of the turn (the quarantine tools, the heal, the backfills and seeds, the extraction and derivation jobs, the source tools) has its dispatch path here,
// `turn --stage ops --input '{"ops":{"op":"<name>","args":{...}}}'`, recorded under the `ops` family like any other firing. An op never reads the wall clock or a client of its own: it takes the turn's deps.
import type { FamilyCall } from "@/core/harness";
import { surfaceOf } from "@/core/routing";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";
import { runNotificationOutbox } from "@/features/drain";
import { groundInjected, eraseQuarantined, idStamp, planQuarantine, rehomeQuarantined, resolveQuarantined } from "@/features/intake";
import { triggerQuestionsForItem } from "@/features/learning";
import { healItem, healQuarantined, rederiveStale, reopenHolds } from "@/features/mint";
import { deriveObligationsJob, extractBackfill, runExtractionJob } from "@/features/obligations";
import { backfillDerivationEdges, backfillEntities, backfillLineageEdges, seedCorridors, seedDerivedValues } from "@/features/propagation/ops";
import { classifySources, triageSuspended, verifyCandidate } from "@/features/sources";
import { statutoryRun } from "@/features/statutory";

import type { BuiltDeps } from "./wiring";

type Args = Record<string, unknown>;
type Op = (c: FamilyCall, d: BuiltDeps, a: Args) => Promise<RunResult>;
const owed = (what: string, owner: string): RunResult => runResult("failed", { refused: 1 }, [`refused: ${what} is owed by ${owner} and is not wired yet`]);
const heal = (d: BuiltDeps) => ({ sb: d.sb, now: d.now, fetch: d.fetch });
const fetchDeps = (d: BuiltDeps) => ({ db: d.sb, now: d.now, env: d.env, ...(d.fetch.fetchImpl ? { fetchImpl: d.fetch.fetchImpl } : {}) });

/** Every operator task by name. An apply op (`apply`) is a dry plan unless the frame resolved apply; a dry op (`dry`) is the reverse flag. */
export const OPS: Readonly<Record<string, Op>> = {
  "run-notification-outbox": (c, d, a) => runNotificationOutbox({ sb: d.sb, now: d.now }, { dry: c.dry, ...(typeof a.limit === "number" ? { limit: a.limit } : {}) }),
  "ground-injected": (c, d, a) => groundInjected({ sb: d.sb, sources: d.sources, recorder: d.recorder }, ({ ...a, dry: c.dry } as never)),
  "erase-quarantined": (c, d, a) => eraseQuarantined({ sb: d.sb }, ({ ...a, apply: !c.dry } as never)),
  "id-stamp": (c, d, a) => idStamp({ sb: d.sb, sources: d.sources }, ({ ...a, apply: !c.dry } as never)),
  "plan-quarantine": (c, d) => planQuarantine({ sb: d.sb, now: d.now }, { apply: !c.dry }),
  "rehome-quarantined": (c, d, a) => rehomeQuarantined({ sb: d.sb, sources: d.sources, now: d.now }, { ...a, apply: !c.dry }),
  "resolve-quarantined": (c, d, a) => resolveQuarantined(d.sb, { ...a, apply: !c.dry }),
  "trigger-questions": (c, d, a) => triggerQuestionsForItem({ sb: d.sb, now: d.now }, { items: (a.items ?? []) as never, dry: c.dry }),
  "reopen-holds": (c, d, a) => reopenHolds({ sb: d.sb, now: d.now }, { reasonContains: String(a.reasonContains ?? ""), dry: c.dry }),
  "heal-item": (c, d, a) => healItem(heal(d), ({ ...a, dry: c.dry } as never)),
  "heal-quarantined": (c, d, a) => healQuarantined(heal(d), { ...a, dry: c.dry }),
  "rederive-stale": (c, d, a) => rederiveStale(heal(d), { ...a, dry: c.dry }),
  "derive-obligations": (c, d, a) => deriveObligationsJob({ sb: d.sb }, { ...a, dry: c.dry }),
  "extract-backfill": (c, d, a) => extractBackfill({ sb: d.sb, now: d.now }, { ...a, dry: c.dry }),
  "run-extraction": (c, d, a) => runExtractionJob({ sb: d.sb, now: d.now }, { items: (a.items ?? []) as never, dry: c.dry }),
  "backfill-derivation-edges": async (c, d, a) => (d.edgeAuthors ? backfillDerivationEdges({ sb: d.sb, now: d.now, authors: d.edgeAuthors }, { ...a, dry: c.dry }) : owed("EdgeAuthors (authorCarbonIntensityEdges)", "P2-11 market surface")),
  "backfill-entities": (c, d, a) => backfillEntities({ sb: d.sb, now: d.now }, { ...a, dry: c.dry }),
  "backfill-lineage-edges": (c, d, a) => backfillLineageEdges({ sb: d.sb, now: d.now }, { ...a, dry: c.dry }),
  "seed-corridors": (c, d) => seedCorridors({ sb: d.sb, now: d.now }, { dry: c.dry }),
  "seed-derived-values": async (c, d) => (d.marketMethods ? seedDerivedValues({ sb: d.sb, now: d.now, carbonIntensity: d.marketMethods.carbonIntensity }, { dry: c.dry }) : owed("carbonIntensity", "P2-11 market surface")),
  "classify-sources": (c, d, a) => classifySources({ db: d.sb, now: d.now, surfaceOf }, { ...a, dry: c.dry }),
  "triage-suspended": (c, d, a) => triageSuspended(fetchDeps(d), { ...a, apply: !c.dry }),
  "verify-candidate": (c, d, a) => verifyCandidate(fetchDeps(d), ({ ...a, dry: c.dry } as never)),
  "statutory-run": async (c, d, a) => (d.statutory ? statutoryRun({ sb: d.sb, now: d.now, statutory: d.statutory }, { dry: c.dry, file: a.file }) : owed("computeStatutory", "P2-10 regulations surface")),
};

export const opNames = (): string[] => Object.keys(OPS);

/** Run one named op. An unknown name, or a missing one, is a refusal that lists the names. */
export async function runOps(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const spec = (call.input.ops ?? call.input) as { op?: unknown; args?: Args };
  const name = typeof spec.op === "string" ? spec.op : "";
  const op = Object.hasOwn(OPS, name) ? OPS[name] : undefined;
  if (!op) return runResult("failed", { refused: 1 }, [`unknown op "${name}" (ops: ${opNames().join(", ")})`]);
  const r = await op(call, d, spec.args ?? {});
  return { ...r, counts: { ...r.counts }, notes: [`op=${name}`, ...r.notes] };
}
