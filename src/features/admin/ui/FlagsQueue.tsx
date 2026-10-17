"use client";

// Ported from old_repo/src/components/admin/redesign/FlagsRejectionsQueue.tsx (lines 39-162)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { SectionCard, SectionHead, TabRow } from "@/ui";

import type { AttentionCounts } from "../api/attention";

import { BriefFlagsView } from "./BriefFlagsView";
import { IngestRejectionsLog } from "./IngestRejectionsLog";
import { PlatformFlagsView } from "./PlatformFlagsView";
import { flagKinds, type Kind } from "./console-math";
import styles from "./admin.module.css";

/** One queue, three kinds, the same triage verbs across them: review, fix, resolve or archive. */
export function FlagsQueue({ counts, nowMs }: { counts: AttentionCounts | null; nowMs: number }) {
  const [kind, setKind] = useState<Kind>("integrity");
  const kinds = flagKinds(counts);
  const open = kinds.reduce<number | null>((t, k) => (k.count === null ? t : (t ?? 0) + k.count), null);
  return (
    <div className={styles.stack}>
      <SectionCard as="section" aria-label="Flags and rejections">
        <SectionHead title="Flags & rejections" aside={open === null ? "one queue, three kinds" : `${formatNumber(open)} open across the three kinds`} />
        <TabRow ariaLabel="Flag kind" semantics="tablist" tabs={kinds.map((k) => ({ key: k.key, label: `${k.label}${k.count === null ? "" : ` · ${formatNumber(k.count)}`}`, active: k.key === kind, onClick: () => setKind(k.key) }))} />
      </SectionCard>
      {kind === "integrity" ? <BriefFlagsView nowMs={nowMs} /> : kind === "platform" ? <PlatformFlagsView /> : <IngestRejectionsLog />}
    </div>
  );
}
