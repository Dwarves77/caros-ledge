"use client";

// Ported from old_repo/src/components/admin/StatutoryRowsUpload.tsx (lines 83-275)
import { useState, type ChangeEvent } from "react";

import { requestJson } from "@/core/http/request-json";
import { Button, FilePickRow, InlineErrorBanner, StateNote, Textarea } from "@/ui";

import { Panel } from "./panel-kit";
import styles from "./admin.module.css";

interface RunResult {
  mode: "dry" | "apply";
  total: number;
  counts: Record<string, number>;
  outcomes: { id: string; outcome: string; detail: string | null }[];
  notes: string[];
}
const OUTCOME_LABEL: Record<string, string> = { written: "Written", "would-write": "Would write (dry)", "skipped-already-computed": "Already computed, skipped", "refused-inadmissible": "Refused: not admissible for filing", "refused-structural": "Refused: structural error", errored: "Errored" };

/** The summary line of a run, from its counts. Pure. */
const summaryOf = (r: Pick<RunResult, "mode" | "total" | "counts">): string => `${r.mode === "apply" ? "Applied" : "Dry run"}: ${r.total} row${r.total === 1 ? "" : "s"}, written ${r.counts.written ?? 0}, would write ${r.counts.would_write ?? 0}, already computed ${r.counts.skipped_already ?? 0}, refused ${r.counts.refused ?? 0}, errored ${r.counts.errored ?? 0}.`;

/** Preview and apply a reviewed statutory rows file. Apply unlocks only after a clean dry run of this exact text; editing the text locks it again. Operator-entered platform data, validated whole before any row is read. */
export function StatutoryRowsUpload() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; violations: string[] } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [cleanFor, setCleanFor] = useState<string | null>(null);
  const reset = () => {
    setError(null);
    setResult(null);
  };
  const run = async (mode: "dry" | "apply") => {
    let file: unknown;
    try {
      file = JSON.parse(text);
    } catch (e) {
      return setError({ message: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}`, violations: [] });
    }
    setBusy(true);
    reset();
    const r = await requestJson<RunResult & { violations?: string[] }>(`/api/admin/statutory-rows?mode=${mode}`, { method: "POST", body: file });
    setBusy(false);
    if (!r.ok || !r.data) {
      setCleanFor(null);
      return setError({ message: r.error ?? "The run did not complete.", violations: r.data?.violations ?? [] });
    }
    setResult(r.data);
    setCleanFor(mode === "dry" && !r.data.counts.refused && !r.data.counts.errored ? text : null);
  };
  const canApply = cleanFor !== null && cleanFor === text && !busy;
  return (
    <Panel title="Statutory rows">
      <p className={styles.note}>Upload a reviewed statutory rows file to write the computed penalty rows. Run it dry first: it writes nothing and shows what each row would do. Apply unlocks after a clean dry run of this same text. A placeholder marker anywhere in the file is refused before any row is read.</p>
      <FilePickRow label="Choose rows-file JSON" hint="or paste JSON below" accept=".json,application/json" onFile={async (e: ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        if (!f) return;
        try {
          setText(await f.text());
          setCleanFor(null);
          reset();
        } catch (err) {
          setError({ message: `Could not read that file: ${err instanceof Error ? err.message : String(err)}`, violations: [] });
        }
      }} />
      <Textarea rows={10} spellCheck={false} aria-label="Statutory rows JSON" value={text} onChange={(e) => { setText(e.target.value); setCleanFor(null); reset(); }} />
      <div className={styles.actions}>
        <Button variant="secondary" disabled={!text.trim() || busy} onClick={() => run("dry")}>{busy ? "Running..." : "Run dry"}</Button>
        <Button variant="primary" disabled={!canApply} onClick={() => run("apply")}>Apply</Button>
        {!canApply && !busy ? <span className={styles.muted}>Apply unlocks after a clean dry run of this exact text.</span> : null}
      </div>
      {error ? <InlineErrorBanner message={error.message}>{error.violations.length ? <ul>{error.violations.map((v, i) => <li key={i}>{v}</li>)}</ul> : null}</InlineErrorBanner> : null}
      {result ? (
        <div className={styles.stack}>
          <StateNote>{summaryOf(result)}</StateNote>
          {result.outcomes.map((o, i) => (
            <p key={i} className={styles.note}><b>{o.id}</b>: {OUTCOME_LABEL[o.outcome] ?? o.outcome}{o.detail ? ` (${o.detail})` : ""}</p>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}
