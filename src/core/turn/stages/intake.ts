// Ported from old_repo/scripts/turns/run-ledger-consume.mjs (lines 835-1005)
// Ported from old_repo/scripts/turns/run-ledger-consume.mjs (lines 1117-1134)
// Ported from old_repo/scripts/turns/run-ledger-consume.mjs (lines 1494-1897)
// Stage 5, intake: the portal ledger consumed by session verdict (a candidate with no verdict is skipped and owed, never sent anywhere), promoted under the cap and minted at record grade through
// the one chokepoint; optionally the census worklist through the mint family. Before any apply that starts a new slice, THE GATE reads the ledger.
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { runResult, worst } from "@/core/types/run-result";
import { consumePortalCandidates } from "@/features/intake";
import type { ConsumeResult } from "@/features/intake/portal-ledger";
import { runMint } from "@/features/mint";
import type { MintRunInput } from "@/features/mint";

import { gateRefusal, readSliceState } from "../gate";
import type { BuiltDeps } from "../wiring";

const INTAKE_DEFAULT_LIMIT = 25;
const INTAKE_MAX_PROMOTE = 50;
const INTAKE_CEILING = 200;

export interface IntakePlan {
  limit: number;
  maxPromote: number;
  sourceId: string | undefined;
  verdicts: Map<string, unknown>;
  census: MintRunInput | null;
}
/** Validate the stage input. The promote cap is enforced, never clamped: a request above the ceiling is an error. Pure. */
function planIntake(input: Record<string, unknown>): { plan: IntakePlan; errors: string[] } {
  const errors: string[] = [];
  const limit = typeof input.limit === "number" ? Math.floor(input.limit) : INTAKE_DEFAULT_LIMIT;
  const maxPromote = typeof input.maxPromote === "number" ? Math.floor(input.maxPromote) : INTAKE_MAX_PROMOTE;
  if (limit < 1 || limit > INTAKE_CEILING) errors.push(`limit must be 1..${INTAKE_CEILING}, got ${limit}`);
  if (maxPromote < 0 || maxPromote > INTAKE_CEILING) errors.push(`maxPromote must be 0..${INTAKE_CEILING}, got ${maxPromote}`);
  const v = input.verdicts && typeof input.verdicts === "object" ? Object.entries(input.verdicts as Record<string, unknown>) : [];
  return { plan: { limit, maxPromote, sourceId: typeof input.sourceId === "string" ? input.sourceId : undefined, verdicts: new Map(v), census: input.census && typeof input.census === "object" ? (input.census as MintRunInput) : null }, errors };
}

/** Roll the ledger consume and the census mint into the stage result; the minted ids are the hand-off to connect. Pure. */
export function shapeIntake(consume: ConsumeResult | null, mint: (RunResult & { mintedIds?: string[] }) | null): RunResult {
  const by = (d: string) => consume?.outcomes.filter((o) => o.disposition === d).length ?? 0;
  const promoted = consume?.outcomes.filter((o) => o.disposition === "promoted" && o.itemId).map((o) => o.itemId as string) ?? [];
  const minted = [...new Set([...promoted, ...(mint?.mintedIds ?? [])])];
  const counts = {
    discovered: consume?.discovered ?? 0, fetched: consume?.fetched ?? 0, classified: consume?.classified ?? 0, promoted: promoted.length, exists: by("exists"), rejected: by("rejected") + by("not_an_item"), stamped: by("promoted") + by("rejected") + by("not_an_item"),
    would_mint: by("would_mint"), skipped: by("skipped"), verdicts_owed: consume?.outcomes.filter((o) => o.reason.startsWith("skipped-no-verdict")).length ?? 0, minted: minted.length,
    ...Object.fromEntries(Object.entries(mint?.counts ?? {}).map(([k, v]) => [`mint_${k}`, v])),
  };
  return { ...runResult(worst(consume?.outcome ?? "ok", mint?.outcome ?? "ok"), counts, [...(consume?.notes ?? []), ...(mint?.notes ?? [])]), data: { ids: { minted_item_ids: minted } } };
}

export async function runIntake(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const { plan, errors } = planIntake(call.input);
  if (errors.length) return runResult("failed", { refused: 1 }, errors);
  if (!call.dry) {
    let refusal: string | null;
    try {
      refusal = gateRefusal(await readSliceState(d.sb));
    } catch (e) {
      return runResult("failed", { refused: 1 }, [`THE GATE could not read the ledger (${e instanceof Error ? e.message : String(e)}): refusing`]);
    }
    if (refusal) return runResult("failed", { refused: 1 }, [refusal]);
  }
  await d.gate.refresh();
  const consume = await consumePortalCandidates(d.intake, { mode: call.dry ? "plan" : "apply", limit: plan.limit, ...(plan.sourceId ? { sourceId: plan.sourceId } : {}), verdicts: plan.verdicts, maxPromote: plan.maxPromote, recordOnly: true });
  const mint = plan.census ? await runMint(d.mintRun, { ...plan.census, dry: call.dry }) : null;
  return shapeIntake(consume, mint);
}
