"use client";

// Ported from old_repo/src/components/sources/ProvisionalReviewCard.tsx (lines 180-446)
// Ported from old_repo/src/components/sources/CanonicalSourceReview.tsx (lines 609-944)
import { useState } from "react";

import { DOMAIN_LABELS } from "@/core/shared/domains";
import { hostOf } from "@/core/shared";
import { biasTagLabel } from "@/core/sources/bias-tags";
import { classTierForHost } from "@/core/sources/host-class";
import { TIER_LABELS } from "@/core/sources/tier-contract";
import { MODES } from "@/core/workspace/vocabulary";
import { Button, ChoiceChip, FormField, Input, Select, Textarea } from "@/ui";
import styles from "@/features/admin/ui/admin.module.css";

import { SOURCE_TIERS } from "./TierLegend";

export type Decision = "approve" | "reject" | "defer";
export interface ClassificationDraft {
  assignedTier: number | null;
  domains: number[];
  jurisdictions: string[];
  transport_modes: string[];
  topic_tags: string[];
  reviewerNotes: string;
}
export interface EditorSeed {
  name: string;
  url: string;
  tier?: number | null;
  domains?: number[];
  jurisdictions?: string[];
  transport_modes?: string[];
  topic_tags?: string[];
  biasTags?: unknown;
}

const list = (v: string): string[] => v.split(/[,|;]+/).map((s) => s.trim()).filter(Boolean);

/** The editor's opening state: the tier is the CLASS TABLE's for this host and name (never a model's), and the other axes are what the candidate was found for. Pure. */
function seedDraft(seed: EditorSeed): { draft: ClassificationDraft; classTier: number | null } {
  const classTier = classTierForHost(hostOf(seed.url), seed.name);
  return { classTier, draft: { assignedTier: seed.tier ?? classTier, domains: seed.domains ?? [], jurisdictions: seed.jurisdictions ?? [], transport_modes: seed.transport_modes ?? [], topic_tags: seed.topic_tags ?? [], reviewerNotes: "" } };
}

/** The stored bias tags in words, from the drafts the registry already holds (a tag outside the vocabulary is humanised, never dropped). Pure. */
function biasPreview(tags: unknown): string[] {
  if (!tags || typeof tags !== "object") return [];
  return Object.values(tags as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v.map((e) => `${biasTagLabel((e as { tag?: unknown }).tag)}${typeof (e as { confidence?: unknown }).confidence === "number" ? ` ${Math.round(((e as { confidence: number }).confidence) * 100)}%` : ""}`) : []));
}

/**
 * THE classification editor for a source decision, provisional or canonical: the tier seeded by the class table (and said to be, or said to be missing), domains, jurisdictions, modes and topics, a note, and the three
 * decisions. Choosing a tier other than the class table's is allowed; it lands as an operator override with the note as its reason. Every control is 44 px.
 */
export function SourceClassificationEditor({ seed, busy, onDecide }: { seed: EditorSeed; busy: boolean; onDecide: (decision: Decision, draft: ClassificationDraft) => void }) {
  const { draft: first, classTier } = seedDraft(seed);
  const [d, setD] = useState<ClassificationDraft>(first);
  const [juris, setJuris] = useState(first.jurisdictions.join(", "));
  const [topics, setTopics] = useState(first.topic_tags.join(", "));
  const toggle = <T,>(arr: T[], v: T): T[] => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const out = (): ClassificationDraft => ({ ...d, jurisdictions: list(juris), topic_tags: list(topics) });
  const bias = biasPreview(seed.biasTags);
  const needsTier = classTier === null && d.assignedTier === null;
  return (
    <div className={styles.detail}>
      <p className={styles.note}>{classTier === null ? "The class table does not place this host: choose its tier." : `The class table places this host at T${classTier} (${TIER_LABELS[classTier]}).`}</p>
      <div className={styles.grid2}>
        <FormField label="Tier" required hint={d.assignedTier !== null && classTier !== null && d.assignedTier !== classTier ? "Different from the class table: recorded as an operator override with your note." : undefined}>
          {(c) => <Select {...c} value={d.assignedTier ?? ""} onChange={(e) => setD({ ...d, assignedTier: e.target.value ? Number(e.target.value) : null })}><option value="">Choose a tier</option>{SOURCE_TIERS.map((t) => <option key={t} value={t}>T{t} {TIER_LABELS[t]}</option>)}</Select>}
        </FormField>
        <FormField label="Jurisdictions" hint="Codes such as EU, US, US-CA.">{(c) => <Input {...c} value={juris} onChange={(e) => setJuris(e.target.value)} />}</FormField>
      </div>
      <FormField label="Domains" group>{() => <div className={styles.chips}>{(Object.keys(DOMAIN_LABELS) as unknown as (keyof typeof DOMAIN_LABELS)[]).map((k) => <ChoiceChip key={k} label={DOMAIN_LABELS[k]} pressed={d.domains.includes(Number(k))} onToggle={() => setD({ ...d, domains: toggle(d.domains, Number(k)) })} />)}</div>}</FormField>
      <FormField label="Transport modes" group>{() => <div className={styles.chips}>{MODES.map((m) => <ChoiceChip key={m.id} label={m.label} pressed={d.transport_modes.includes(m.id)} onToggle={() => setD({ ...d, transport_modes: toggle(d.transport_modes, m.id) })} />)}</div>}</FormField>
      <FormField label="Topics" hint="Comma separated.">{(c) => <Input {...c} value={topics} onChange={(e) => setTopics(e.target.value)} />}</FormField>
      {bias.length ? <p className={styles.note}>Bias tags on record: {bias.join(", ")}.</p> : null}
      <FormField label="Note">{(c) => <Textarea {...c} rows={2} value={d.reviewerNotes} onChange={(e) => setD({ ...d, reviewerNotes: e.target.value })} maxLength={2000} />}</FormField>
      <div className={styles.actions}>
        <Button variant="primary" size="sm" disabled={busy || needsTier} onClick={() => onDecide("approve", out())}>Approve</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide("reject", out())}>Reject</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide("defer", out())}>Defer</Button>
      </div>
    </div>
  );
}
