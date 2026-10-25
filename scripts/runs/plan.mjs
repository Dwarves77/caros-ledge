// A ruled run is a committed plan file (scripts/runs/plans/<date>-<name>.json): the operator's ruling and the ordered turn steps it carries. The validator refuses a plan that could not be run exactly as ruled.
// It imports the turn's own stage list, so the plan can never name a stage the turn does not have; producer_env is validated with the same pattern the turn job's workflow step applies.
import { readFileSync } from "node:fs";

import { z } from "zod";

import { STAGES } from "../../src/core/turn/registry.ts";

export const PRODUCER_ENV = /^[A-Z0-9_]+_ENABLED=1$/;
/** The producers the registry lists: a step that names another in producers.only would run nothing, so the plan is refused. */
const REGISTRY = new Set(JSON.parse(readFileSync(new URL("../../src/core/producers/data/registry.json", import.meta.url), "utf8")).map((e) => e.name));

const Step = z.strictObject({
  name: z.string().min(1),
  stage: z.enum(STAGES),
  mode: z.enum(["dry", "apply"]),
  input: z.record(z.string(), z.unknown()),
  producer_env: z.array(z.string().regex(PRODUCER_ENV)),
  /** A ruled step runs the named stage alone unless the plan says otherwise. */
  chain: z.boolean().default(false),
});

export const Plan = z
  .strictObject({
    ruling: z.string().min(1).refine((s) => s.trim() === s, "the ruling has no leading or trailing space"),
    /** Bumped when a plan is re-run after a fix: the push that changes the file starts the job, and the ledger still skips every step that already succeeded. */
    revision: z.number().int().min(2).optional(),
    steps: z.array(Step).min(1),
  })
  // INV-RUN-1: the ruling travels with every apply that fetches (propagate): the stage opens its producers only for a call that carries the ruling text, and the ledger row records it.
  .superRefine((p, ctx) => {
    p.steps.forEach((s, i) => {
      if (s.mode === "apply" && s.stage === "propagate" && s.input.propagate?.cadence_exception !== p.ruling) ctx.addIssue({ code: "custom", path: ["steps", i, "input"], message: `step "${s.name}": an apply propagate step needs input.propagate.cadence_exception equal to the plan ruling` });
    });
  })
  .superRefine((p, ctx) => {
    p.steps.forEach((s, i) => {
      const only = s.input.propagate?.producers?.only;
      if (only !== undefined && !REGISTRY.has(only)) ctx.addIssue({ code: "custom", path: ["steps", i, "input"], message: `step "${s.name}": producers.only "${String(only)}" is not an entry of src/core/producers/data/registry.json` });
    });
  })
  .superRefine((p, ctx) => {
    if (new Set(p.steps.map((s) => s.name)).size !== p.steps.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "step names are unique" });
  });

/** The plan in `text`, or a ZodError / SyntaxError naming the defect. */
export const parsePlan = (text) => Plan.parse(JSON.parse(text));
