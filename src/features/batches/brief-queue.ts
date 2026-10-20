// Ported from old_repo/scripts/turns/brief-export/queue.mjs (lines 1-181)
// Ported from old_repo/scripts/turns/read-brief-export-queue.mjs (lines 1-105)


export interface QueueEntry { runId: string; exportedAt: string; ids: string[]; parts: string[] }

