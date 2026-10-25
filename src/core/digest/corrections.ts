// New in FLY-1 (ADR-050): the shape of <batch>.corrections.json, the file the briefs stage writes next to a held batch and the next drain plan reads. One schema, written by src/features/batches/committed.ts and imported by DIGEST-1 PR B's plan, so neither guesses the other's shape.
import { z } from "zod";

export const correctionsFile = z
  .object({
    /** The batch id: the file name without .json. */
    batch: z.string().min(1),
    /** The kit kind of the batch (a digest kind id, or screen-verdicts / forward-events). */
    kind: z.string().min(1),
    held_at: z.iso.datetime(),
    /** sha256 of the batch file as read; a corrected batch is a new file with another hash. */
    file_hash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The entries the validator refused, with every reason (entry index, entry key, reasons). */
    refused: z.array(z.object({ index: z.number().int().nonnegative(), key: z.string().nullable(), errors: z.array(z.string()).min(1) }).strict()),
    /** The run's notes: file-level refusals and read-back failures that name no entry. */
    notes: z.array(z.string()),
  })
  .strict();
export type CorrectionsFile = z.infer<typeof correctionsFile>;
