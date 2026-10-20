"use client";

// Ported from old_repo/src/components/admin/CorpusTurnPanel.tsx (lines 72-359)
// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 808-883)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Button, FormField, Input, RelativeTime, Select, StatBlock, StateNote } from "@/ui";
import { requestJson } from "@/core/http/request-json";

import { Load, Panel, useAct, useAdminFetch, useFlash } from "./panel-kit";
import { useReason } from "./reason-dialog";
import styles from "./admin.module.css";

interface Queue {
  open: { id: string; reason: string; requested_at: string; item: { title: string } | null }[];
  open_count: number;
  capped: boolean;
  last_consumed_at: string | null;
}
interface Dispatched {
  ok?: boolean;
  mode?: string;
  forced_dry?: boolean;
  reason?: string | null;
  outcome?: string | null;
  query?: string;
  counts?: Record<string, number>;
  notes?: string[];
  result?: { counts?: Record<string, number>; notes?: string[]; items?: { title: string; disposition: string; reason?: string }[] } | null;
  error?: string | null;
}

/** A dispatch result in words, not raw JSON: the mode it ran in and why, the outcome, the counts, and each candidate's disposition. Pure. */
function describeDispatch(r: Dispatched): string[] {
  const counts = r.counts ?? r.result?.counts ?? {};
  const lines = [`Ran in ${r.mode ?? "dry"} mode${r.forced_dry || r.reason ? `: ${r.reason ?? "forced dry by the build-mode gate"}` : ""}.`, r.outcome ? `Outcome: ${r.outcome}.` : "", Object.keys(counts).length ? `Counts: ${Object.entries(counts).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", ")}.` : ""];
  for (const i of r.result?.items ?? []) lines.push(`${i.title}: ${i.disposition.replace(/_/g, " ")}${i.reason ? ` (${i.reason})` : ""}`);
  lines.push(...(r.notes ?? r.result?.notes ?? []).slice(0, 8));
  if (r.error) lines.push(r.error);
  return lines.filter(Boolean);
}

function Result({ r }: { r: Dispatched | null }) {
  if (!r) return null;
  return <StateNote tone={r.ok === false ? "error" : "note"}>{describeDispatch(r).map((l, i) => <span key={i} className={styles.wrap}>{l}<br /></span>)}</StateNote>;
}

/** The manual triggers, all through the turn: request a re-capture of an item (or every live item), dispatch a topic and jurisdiction sweep, run one intake cycle. While the cadence is off, an apply is planned and says so. */
export function DispatchPanel() {
  const queue = useAdminFetch<Queue>("/api/admin/corpus-turn-requests");
  const flash = useFlash();
  const act = useAct(flash, queue.reload);
  const why = useReason();
  const [itemId, setItemId] = useState("");
  const [topic, setTopic] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [sweep, setSweep] = useState<Dispatched | null>(null);
  const [candidate, setCandidate] = useState({ title: "", source_url: "", item_type: "" });
  const [mode, setMode] = useState<"plan" | "apply">("plan");
  const [intake, setIntake] = useState<Dispatched | null>(null);
  return (
    <div className={styles.stack}>
      <Panel title="Turn queue" onRefresh={queue.reload}>
        <p className={styles.note}>A request tells the next turn to fetch and re-ground an item. One open request per item; the turn consumes it and records the outcome.</p>
        <Load q={queue} what="The turn queue">
          {(d) => (
            <div className={styles.grid2}>
              <StatBlock label="Open requests" value={formatNumber(d.open_count)} note={d.capped ? `Listing the oldest ${d.open.length}` : undefined} />
              <StatBlock label="Last consumed" value={d.last_consumed_at ? <RelativeTime iso={d.last_consumed_at} /> : "never"} />
            </div>
          )}
        </Load>
        <div className={styles.actions}>
          <FormField label="Item id">{(c) => <Input {...c} value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="Item id (uuid)" />}</FormField>
          <Button variant="primary" disabled={!itemId.trim() || act.busy !== null} onClick={async () => { const reason = await why.ask({ title: "Request a turn for this item", body: "The next turn fetches and re-grounds it.", action: "Request" }); if (!reason) return; const r = await act.run("item", "/api/admin/corpus-turn-requests", { method: "POST", body: { itemId: itemId.trim(), reason } }, (x) => ((x as { already_open?: boolean } | null)?.already_open ? "That item already has an open request." : "Request created.")); if (r.ok) setItemId(""); }}>Request for this item</Button>
          <Button variant="secondary" disabled={act.busy !== null} onClick={async () => { const p = await requestJson<{ total_live: number; already_open: number; would_request: number }>("/api/admin/corpus-turn-requests?preview=all"); if (!p.ok || !p.data) { flash.show(p.error ?? "The count could not be read.", true); return; } const n = p.data; const reason = await why.ask({ title: "Re-ground the whole live corpus", body: `This opens ${formatNumber(n.would_request)} requests (${formatNumber(n.total_live)} live items, ${formatNumber(n.already_open)} already have one). The turn works through them one by one.`, action: `Request ${formatNumber(n.would_request)} turns`, phrase: "re-ground all" }); if (reason) await act.run("all", "/api/admin/corpus-turn-requests", { method: "POST", body: { all: true, reason } }, (x) => { const d = x as { inserted?: number; already_open?: number; total_live?: number } | null; return `${d?.inserted ?? 0} new requests; ${d?.already_open ?? 0} items already had one (${d?.total_live ?? 0} live).`; }); }}>Request for all live items</Button>
        </div>
      </Panel>
      <Panel title="Dispatch a sweep">
        <p className={styles.note}>Search for new material on a topic and jurisdiction. It runs the research walk through the turn: the walk is the discovery, the gates are the approval.</p>
        <div className={styles.grid2}>
          <FormField label="Topic" required>{(c) => <Input {...c} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="carbon pricing, packaging, SAF" />}</FormField>
          <FormField label="Jurisdiction">{(c) => <Input {...c} value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="optional" />}</FormField>
        </div>
        <div className={styles.actions}>
          <Button variant="primary" disabled={topic.trim().length < 2 || act.busy !== null} onClick={async () => { const r = await act.run("sweep", "/api/admin/corpus-turn-requests", { method: "POST", body: { sweep: { topic: topic.trim(), ...(jurisdiction.trim() ? { jurisdiction: jurisdiction.trim() } : {}) } } }, "Sweep dispatched."); setSweep(r.ok ? (r.data as Dispatched) : { ok: false, error: r.error }); }}>Dispatch sweep</Button>
        </div>
        <Result r={sweep} />
      </Panel>
      <Panel title="Run intake now">
        <p className={styles.note}>One intake cycle over one named candidate, then stop. Plan shows the gate verdict and writes nothing; apply mints at record grade through the same gates. There is no approval step after it.</p>
        <div className={styles.grid3}>
          <FormField label="Title" required>{(c) => <Input {...c} value={candidate.title} onChange={(e) => setCandidate({ ...candidate, title: e.target.value })} />}</FormField>
          <FormField label="Source address" required>{(c) => <Input {...c} type="url" value={candidate.source_url} onChange={(e) => setCandidate({ ...candidate, source_url: e.target.value })} placeholder="https://" />}</FormField>
          <FormField label="Item type" required>{(c) => <Input {...c} value={candidate.item_type} onChange={(e) => setCandidate({ ...candidate, item_type: e.target.value })} placeholder="regulation" />}</FormField>
        </div>
        <div className={styles.actions}>
          <FormField label="Mode">{(c) => <Select {...c} value={mode} onChange={(e) => setMode(e.target.value as "plan" | "apply")}><option value="plan">Plan (read-only)</option><option value="apply">Apply</option></Select>}</FormField>
          <Button variant="primary" disabled={act.busy !== null || !candidate.title.trim() || !candidate.source_url.trim() || !candidate.item_type.trim()} onClick={async () => { const r = await act.run("intake", "/api/admin/run-intake", { method: "POST", body: { candidates: [{ title: candidate.title.trim(), source_url: candidate.source_url.trim(), item_type: candidate.item_type.trim() }], mode } }, "Intake cycle finished."); setIntake(r.ok ? (r.data as Dispatched) : { ok: false, error: r.error }); }}>Run intake now</Button>
        </div>
        <Result r={intake} />
      </Panel>
      {flash.node}
      {why.node}
    </div>
  );
}
