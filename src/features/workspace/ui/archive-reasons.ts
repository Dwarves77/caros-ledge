// Ported from old_repo/src/components/workspace/ArchiveDialog.tsx (lines 60-67)
import { z } from "zod";

import reasons from "../data/archive-reasons.json";

/** The team-archive reasons (workspace_item_overrides.archive_reason). The labels the dialog offers are the labels the archive list shows. */
export const ARCHIVE_REASONS = Object.freeze(z.array(z.object({ value: z.string().min(1), label: z.string().min(1) })).min(1).parse(reasons));

export const reasonLabel = (value: string | null | undefined): string | null => (value ? (ARCHIVE_REASONS.find((r) => r.value === value)?.label ?? value) : null);
