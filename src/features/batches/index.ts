// Barrel: the session-batch kit's import surface (new in P2-08b).
export { applyBatch, BATCH_KINDS, chunkByCharBudget, drainExporters, exportBatch, isBatchKind, scratchDir, validateBatch } from "./kit/dispatch";
export type { BatchKindId, ExportInput, ExportOpts } from "./kit/dispatch";
export { applyEntries, fileShapeErrors, poolHashError, validateEntries } from "./kit/session-batch";
export type { ApplyOpts, BatchData, BatchDeps, BatchExport, EntrySpec, Verdict } from "./kit/session-batch";
export { budgetBytes, decideCooldown, preflight, readLastApplyRun } from "./kit/budget";
export { pendingFrom, readBriefQueue, resolveQueueEntry } from "./brief-queue";
export type { QueueEntry } from "./brief-queue";
