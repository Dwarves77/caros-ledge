// New in DIGEST-1 PR B (scripts/ci/new-files/digest-1b.txt), DIGEST-1 D4 as re-specified by the eval-audit ruling (2026-10-25): the second reader. The single 0..1 score is gone. The code-checkable duties are the validator's deterministic rules (VALID-1); the second reader keeps only the
// interpretation criteria, each ONE narrow binary judge (data/judges.json: a failure mode from the error-discovery taxonomy, a pass/fail prompt, a TPR and TNR measured on a held-out split). A session answers every judge that applies to a brief with pass or fail and the evidence it
// rests on; every required judge must pass, or the brief is residue with the failing criterion named. This module is the machine side: which judges apply, and what the verdicts a session returned amount to. Nothing here judges language (ADR-053).
import { z } from "zod";

import raw from "./data/judges.json";

const judge = z.object({
  id: z.string().regex(/^J\d{2}$/),
  criterion: z.string().min(1),
  /** Where the failure mode came from: a Step A item (A1..A17), the three emission items (E1..E3), or an error-discovery code (B-<n>). */
  origin: z.string().min(1),
  kinds: z.array(z.string()).min(1),
  /** The formats it applies to (item-briefs only); absent: every format. */
  formats: z.array(z.string()).optional(),
  /** The typed block that must be present for the judge to apply (E2 needs obligation_fields); absent: always. */
  when: z.string().optional(),
  prompt: z.string().min(40),
  /** Measured on the held-out split of the Step B set: absent until measured. */
  validation: z.object({ tpr: z.number().min(0).max(1).nullable(), tnr: z.number().min(0).max(1).nullable(), n_pass: z.number().int(), n_fail: z.number().int() }).strict().optional(),
}).strict();
export type Judge = z.infer<typeof judge>;
const file = z.object({ version: z.string(), /** How the validation figures were measured and how far they can be trusted. */ validation_basis: z.string().min(40), judges: z.array(judge).min(1) }).strict().parse(raw);
if (new Set(file.judges.map((j) => j.id)).size !== file.judges.length) throw new Error("judges.json: a judge id is repeated");
const JUDGES: readonly Judge[] = file.judges;

const present = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null);
/** The judges a brief of this kind and entry must pass: those of its kind and format whose typed block it carries. */
function requiredJudges(kind: string, entry: Record<string, unknown>): Judge[] {
  const format = (entry.metadata as { format_type?: unknown } | null | undefined)?.format_type;
  return JUDGES.filter((j) => j.kinds.includes(kind) && (!j.formats || (typeof format === "string" && j.formats.includes(format))) && (!j.when || present(entry[j.when])));
}

export interface Review { /** The ids of the judges this entry had to pass. */ required: string[]; score: number; reasons: string[]; residue: boolean; reviewed_by: string | null }
/** What the verdicts on an entry amount to: a missing review, a missing or unreasoned verdict and a fail each keep the brief out, naming the criterion. The score is the share of required judges that passed (a record, not a gate). */
export function review(kind: string, entry: Record<string, unknown>): Review {
  const need = requiredJudges(kind, entry);
  const r = entry.review as { reviewed_by?: unknown; judges?: Record<string, { pass?: unknown; evidence?: unknown } | undefined> } | null | undefined;
  const reasons: string[] = [];
  if (!r || typeof r !== "object" || typeof r.reviewed_by !== "string" || !r.reviewed_by.trim() || !r.judges || typeof r.judges !== "object") return { required: need.map((j) => j.id), score: 0, reasons: ["the second reader's verdicts are missing (review: { reviewed_by, judges })"], residue: true, reviewed_by: null };
  let passed = 0;
  for (const j of need) {
    const v = r.judges[j.id];
    if (!v || typeof v.pass !== "boolean") reasons.push(`${j.id} ${j.criterion}: no verdict`);
    else if (typeof v.evidence !== "string" || v.evidence.trim().length < 10) reasons.push(`${j.id} ${j.criterion}: a verdict without its evidence`);
    else if (!v.pass) reasons.push(`${j.id} ${j.criterion}: failed (${v.evidence.trim().slice(0, 200)})`);
    else passed += 1;
  }
  return { required: need.map((j) => j.id), score: need.length ? passed / need.length : 1, reasons, residue: reasons.length > 0, reviewed_by: r.reviewed_by };
}

/** INV-DIG-7 (HOW-TO-LOOK point 3, the no-single-source test): a theme brief or an admin finding cites rows from at least two tables AND at least two surfaces, or it is residue. Pure over the rows it cites. */
export function singleSourceReason(cited: readonly { table: string; surface?: string | null }[]): string | null {
  const tables = new Set(cited.map((c) => c.table));
  const surfaces = new Set(cited.flatMap((c) => (c.surface ? [c.surface] : [])));
  return tables.size < 2 ? `no-single-source test: every cited row is from ${[...tables][0] ?? "no"} table, at least two tables are required` : surfaces.size < 2 ? `no-single-source test: every cited row is on ${[...surfaces][0] ?? "no"} surface, at least two surfaces are required` : null;
}

/** What an export tells the session that reads second: the judges that apply to the kind and where their prompts are (the prompts stay in the file, not in every export). */
export const secondReaderBlock = (kind: string): { version: string; prompts: string; judges: string[] } => ({ version: file.version, prompts: "src/core/digest/data/judges.json", judges: JUDGES.filter((j) => j.kinds.includes(kind)).map((j) => `${j.id} ${j.criterion}`) });
