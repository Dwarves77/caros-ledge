// Barrel: the session-batch kit's import surface (new in P2-08b).
export { applyCommitted, committedNames } from "./committed";
export type { CommittedIds } from "./committed";
export { applyBatch, drainExporters, exportBatch } from "./kit/dispatch";
export type { BatchKindId, ExportInput, ExportOpts } from "./kit/dispatch";
export { applyEntries, poolHashError } from "./kit/session-batch";
export type { ApplyOpts, BatchData, BatchDeps, BatchExport, EntrySpec, Verdict } from "./kit/session-batch";
export { budgetBytes, preflight } from "./kit/budget";
export type { QueueEntry } from "./brief-queue";
