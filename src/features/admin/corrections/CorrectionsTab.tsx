"use client";

// Ported from old_repo/src/components/admin/corrections/CorrectionsTab.tsx (lines 43-152)
import { useMemo, useState } from "react";

import { Button, EmptyState, FormField, Select, StateNote } from "@/ui";

import { useAdminFetch } from "../ui/panel-kit";
import { Load, Panel } from "../ui/panel-kit";
import styles from "../ui/admin.module.css";

import { CorrectionRow } from "./CorrectionRow";
import { ItemSearchPicker } from "./ItemSearchPicker";
import { countByState, filterCorrections, KIND_FILTERS, kindLabel, postRevoke, STATE_FILTERS, stateLabel } from "./model";
import type { CorrectionData } from "./types";

const PAGE = 20;

/** Every correction, newest first, filtered by state and kind and paged. An item whose claims could not be read is counted as unchecked, never guessed orphaned. Revoking restores the machine value; opening an item goes to its single correction screen. */
export function CorrectionsTab() {
  const q = useAdminFetch<{ rows: CorrectionData[]; unchecked: number }>("/api/admin/corrections");
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const data = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const counts = useMemo(() => countByState(rows), [rows]);
  const visible = useMemo(() => filterCorrections(rows, { state, kind }), [rows, state, kind]);
  const revoke = async (c: CorrectionData, reason: string) => {
    const out = await postRevoke(c.item_id, c.id, reason);
    if (!out.ok) return { ok: false, message: out.message };
    setNotice("Revoked. The machine value is back and customers see it now.");
    q.reload();
    return { ok: true };
  };
  return (
    <div className={styles.stack}>
      <Panel title="Corrections to item data" aside={q.data ? `${counts.active} active · ${counts.revoked} revoked · ${counts.orphaned} orphaned` : undefined} onRefresh={q.reload}>
        <Load q={q} what="Corrections">
          {(d) => (
            <>
              {d.unchecked > 0 ? <StateNote>Orphaned status could not be checked for {d.unchecked} {d.unchecked === 1 ? "item" : "items"} with an active fact correction. Open the item to see it.</StateNote> : null}
              <div className={styles.grid2}>
                <FormField label="State">{(c) => <Select {...c} value={state} onChange={(e) => { setState(e.target.value); setShown(PAGE); }}><option value="">All states</option>{STATE_FILTERS.map((s) => <option key={s} value={s}>{stateLabel(s)}</option>)}</Select>}</FormField>
                <FormField label="What was corrected">{(c) => <Select {...c} value={kind} onChange={(e) => { setKind(e.target.value); setShown(PAGE); }}><option value="">Everything</option>{KIND_FILTERS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}</Select>}</FormField>
              </div>
              <ItemSearchPicker label="Open an item to correct it" onPick={(item) => window.location.assign(`/admin/items/${item.id}`)} />
              {notice ? <StateNote>{notice}</StateNote> : null}
              {d.rows.length === 0 ? <EmptyState>No corrections yet. Search for an item above to correct a fact, tag, connection, section or brief. Every value customers see is the machine value until you do.</EmptyState> : visible.length === 0 ? <EmptyState>No corrections match these filters.</EmptyState> : null}
            </>
          )}
        </Load>
      </Panel>
      {visible.slice(0, shown).map((c) => <CorrectionRow key={c.id} correction={c} onRevoke={revoke} itemHref={`/admin/items/${c.item_id}`} />)}
      {visible.length > shown ? <div><Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show more corrections ({visible.length - shown} left)</Button></div> : null}
    </div>
  );
}
