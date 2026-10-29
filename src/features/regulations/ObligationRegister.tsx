"use client";

// Ported from old_repo/src/components/regulations/ObligationRegister.tsx (lines 72-183)
// Ported from old_repo/src/components/regulations/ObligationRegisterFilterBar.tsx (lines 71-486)
// The obligation register, ONE component with two variants: `item` (the rows of one regulation, at the foot of its page; renders nothing when it has none) and `list` (the whole register: filters,
// next-due order, paging). The rows arrive read on the server; a failed seed or a failed refetch is an error state with Retry, never "No obligations on file" (the old register said that for an outage).
// Kind labels and the binding-position words are the vocabularies' (one table each).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { VOCABULARIES } from "@/core/contracts/vocabularies";
import { requestJson } from "@/core/http/request-json";
import { formatForwardEvent } from "@/features/obligations/read/rail-select";
import { KIND_LABELS, type EventKind } from "@/features/obligations/kinds";
import { Button, EmptyState, FormField, RowTable, SectionCard, SectionHead, Select, StateNote, TagChip } from "@/ui";

export interface RegisterRowView {
  id: string;
  jurisdiction: string[];
  modes: string[];
  binding_position: string | null;
  due_date: string | null;
  date_precision: string | null;
  event_kind: string;
  obligation_text: string | null;
  item: { id: string; title: string | null; legacy_id: string | null };
}
export interface RegisterPageView {
  rows: RegisterRowView[];
  total: number;
}
const POSITIONS = Object.values(VOCABULARIES.binding_position ?? {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const WINDOWS: Array<[string, string]> = [["all", "Any date"], ["overdue", "Overdue"], ["30", "Next 30 days"], ["90", "Next 90 days"], ["365", "Next year"], ["undated", "No date"]];
const COLUMNS = [{ label: "Obligation", width: "minmax(0,3fr)" }, { label: "Where", width: "minmax(0,1fr)" }, { label: "Position", width: "minmax(0,1.2fr)" }, { label: "Due", width: "minmax(0,1.2fr)" }];
const ITEM_COLLAPSE_CAP = 20;

const sanitizeObligationText = (raw: string | null | undefined): string =>
  (raw ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/\bclaim:[0-9a-f-]+\s*-->/gi, " ").replace(/&nbsp;/gi, " ").replace(/&[a-z0-9#]{1,6}(?=\.{3}|…|$)/gi, "").replace(/\s+/g, " ").trim();

function Rows({ rows, showItem }: { rows: RegisterRowView[]; showItem: boolean }) {
  return (
    <RowTable
      columns={showItem ? COLUMNS : COLUMNS.filter((c) => c.label !== "Where")}
      rows={rows.map((r) => {
        const cleanText = sanitizeObligationText(r.obligation_text);
        return {
          key: r.id,
          cells: [
            <div key="o" style={{ minWidth: 0 }}>
              {showItem && r.item.title && (
                <Link href={`/regulations/${encodeURIComponent(r.item.legacy_id || r.item.id)}`} prefetch={false} className="cl-detail-link-title cl-detail-link-tap" data-guard-title>
                  {r.item.title}
                </Link>
              )}
              <p className="cl-detail-link-note">{KIND_LABELS[r.event_kind as EventKind] ?? r.event_kind}{cleanText ? ` · ${cleanText}` : ""}</p>
            </div>,
            ...(showItem ? [<span key="w">{[...r.jurisdiction, ...r.modes].join(" · ") || "—"}</span>] : []),
            <TagChip key="p">{POSITIONS.find((p) => p.code === r.binding_position)?.label ?? "Not classified"}</TagChip>,
            <span key="d">{r.due_date ? formatForwardEvent(r.due_date, r.date_precision) : "No date"}</span>,
          ],
        };
      })}
    />
  );
}

export function ObligationRegister({ variant, initial, failed, itemId, jurisdictions = [], modes = [] }: { variant: "item" | "list"; initial: RegisterPageView | null; failed: boolean; itemId?: string; jurisdictions?: string[]; modes?: string[] }) {
  const router = useRouter();
  const [page, setPage] = useState<RegisterPageView | null>(initial);
  const [filter, setFilter] = useState({ jurisdiction: "", mode: "", bindingPosition: "", dueWindow: "all" });
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: failed ? "The obligation register did not load." : null });

  async function fetchPage(next: typeof filter, offset: number) {
    setState({ busy: true, error: null });
    const q = new URLSearchParams({ offset: String(offset), ...(next.jurisdiction ? { jurisdiction: next.jurisdiction } : {}), ...(next.mode ? { mode: next.mode } : {}), ...(next.bindingPosition ? { bindingPosition: next.bindingPosition } : {}), dueWindow: next.dueWindow });
    const r = await requestJson<RegisterPageView>(`/api/obligations/register?${q}`);
    if (!r.ok || !r.data) return setState({ busy: false, error: r.error ?? "The obligation register did not load." });
    setState({ busy: false, error: null });
    setPage((p) => (offset > 0 && p ? { total: r.data?.total ?? p.total, rows: [...p.rows, ...(r.data?.rows ?? [])] } : (r.data as RegisterPageView)));
  }
  const change = (patch: Partial<typeof filter>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    void fetchPage(next, 0);
  };

  if (variant === "item") {
    if (state.error) {
      return (
        <div className="cl-detail-wrap" style={{ paddingTop: "var(--sp-16)" }}>
          <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>{state.error}</StateNote>
        </div>
      );
    }
    if (!page || page.rows.length === 0) return null;
    const headRows = page.rows.slice(0, ITEM_COLLAPSE_CAP);
    const tailRows = page.rows.slice(ITEM_COLLAPSE_CAP);
    return (
      <div id="obligation-register" className="cl-detail-wrap" style={{ paddingTop: "var(--sp-16)" }}>
        <SectionCard as="section" aria-label="Obligation register" padding="0">
          <SectionHead title="Obligation register" aside={`${page.total} ${page.total === 1 ? "obligation" : "obligations"}`} />
          <p className="cl-register-intro">Clause-level statutory events extracted from this instrument. Multiple clauses that share an effective date are grouped into a single milestone on the timeline above.</p>
          <Rows rows={headRows} showItem={false} />
          {tailRows.length > 0 && (
            <div className="cl-register-disclosure">
              <details data-audit="disclosure-row" className="cl-detail-disclosure">
                <summary>Show all {page.rows.length} extracted obligations ({tailRows.length} more)</summary>
                <Rows rows={tailRows} showItem={false} />
              </details>
            </div>
          )}
        </SectionCard>
      </div>
    );
  }
  void itemId;
  return (
    <SectionCard as="section" aria-label="Obligation register" padding="0">
      <SectionHead title="Obligations" aside={page ? `${page.total} on file` : undefined} />
      <div className="cl-form-body" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-end" }}>
        <FormField label="Jurisdiction">{(c) => <Select {...c} value={filter.jurisdiction} onChange={(e) => change({ jurisdiction: e.target.value })}><option value="">All jurisdictions</option>{jurisdictions.map((j) => <option key={j} value={j}>{j.toUpperCase()}</option>)}</Select>}</FormField>
        <FormField label="Mode">{(c) => <Select {...c} value={filter.mode} onChange={(e) => change({ mode: e.target.value })}><option value="">All modes</option>{modes.map((m) => <option key={m} value={m}>{m}</option>)}</Select>}</FormField>
        <FormField label="Position">{(c) => <Select {...c} value={filter.bindingPosition} onChange={(e) => change({ bindingPosition: e.target.value })}><option value="">All positions</option>{POSITIONS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}<option value="unclassified">Not classified</option></Select>}</FormField>
        <FormField label="Due">{(c) => <Select {...c} value={filter.dueWindow} onChange={(e) => change({ dueWindow: e.target.value })}>{WINDOWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</FormField>
      </div>
      {state.error && <StateNote tone="error" action={{ label: "Retry", onClick: () => void fetchPage(filter, 0) }}>{state.error}</StateNote>}
      {page && page.rows.length > 0 ? (
        <>
          <Rows rows={page.rows} showItem />
          {page.rows.length < page.total && (
            <div className="cl-pad-16">
              <Button onClick={() => void fetchPage(filter, page.rows.length)} disabled={state.busy}>{state.busy ? "Loading…" : `Show more (${page.total - page.rows.length} left)`}</Button>
            </div>
          )}
        </>
      ) : (
        !state.error && <div className="cl-pad-16"><EmptyState>{page && page.total === 0 && filter.jurisdiction + filter.mode + filter.bindingPosition === "" && filter.dueWindow === "all" ? "No obligations have been derived yet." : "No obligations match these filters."}</EmptyState></div>
      )}
    </SectionCard>
  );
}
