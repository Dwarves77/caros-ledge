"use client";

// Ported from old_repo/src/components/admin/corrections/ItemCorrectionsPanel.tsx (lines 63-285)
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { Button, SectionCard, SectionHead, StateNote } from "@/ui";

import styles from "../ui/admin.module.css";

import { CorrectionForm, type FormDraft } from "./CorrectionForm";
import { CorrectionRow } from "./CorrectionRow";
import { activeFor, columnLabel, countByState, describeCorrection, fetchItemCorrections, machineValueOf, newestFirst, postCorrection, postRevoke, relationshipLabel, TAG_COLUMNS } from "./model";
import type { CorrectionData, CorrectionOp, ItemTargets, TargetKind } from "./types";

interface OpenForm {
  key: string;
  kind: TargetKind;
  op: CorrectionOp;
  ref: string;
  tagColumn?: string;
  currentText?: string;
  heading: string;
  submitLabel: string;
}
const PAGE = 10;
const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n)}...` : s);

function Block({ id, title, hint, children }: { id: string; title: string; hint?: string; children: ReactNode }) {
  return (
    <SectionCard as="section" aria-labelledby={id}>
      <SectionHead title={<span id={id}>{title}</span>} />
      <div className={styles.body}>{hint ? <p className={styles.note}>{hint}</p> : null}{children}</div>
    </SectionCard>
  );
}

/** The single-pane corrections screen for one item (DP-1): its facts, tags, connections, sections and brief, each with its override action, the active correction noted under the value it overrides, and the history with Revoke. */
export function ItemCorrectionsPanel({ targets }: { targets: ItemTargets }) {
  const [corrections, setCorrections] = useState<CorrectionData[]>([]);
  const [load, setLoad] = useState<{ state: "loading" | "ready" | "error"; message?: string }>({ state: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenForm | null>(null);
  const [facts, setFacts] = useState(PAGE);
  const [sections, setSections] = useState(PAGE);
  const refresh = useCallback(async () => {
    const out = await fetchItemCorrections(targets.item_id);
    if (out.ok) {
      setCorrections(out.corrections);
      setLoad({ state: "ready" });
    } else setLoad({ state: "error", message: out.message });
  }, [targets.item_id]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void refresh();
  }, [refresh]);
  const counts = countByState(corrections);
  const submit = async (draft: FormDraft) => {
    const out = await postCorrection(targets.item_id, draft);
    if (!out.ok) return { ok: false, message: out.message };
    setOpen(null);
    setNotice("Saved. Customers see the corrected value now. To undo it, revoke it under All corrections below and the machine value comes back.");
    await refresh();
    return { ok: true };
  };
  const revoke = async (c: CorrectionData, reason: string) => {
    const out = await postRevoke(targets.item_id, c.id, reason);
    if (!out.ok) return { ok: false, message: out.message };
    setNotice("Revoked. The machine value is back and customers see it now.");
    await refresh();
    return { ok: true };
  };
  const show = (f: Omit<OpenForm, "key">) => {
    setNotice(null);
    setOpen({ ...f, key: `${f.kind}|${f.op}|${f.ref}|${f.tagColumn ?? ""}` });
  };
  const isOpen = (kind: TargetKind, op: CorrectionOp, ref: string, col = "") => open?.key === `${kind}|${op}|${ref}|${col}`;
  const form = (f: OpenForm): ReactNode => <CorrectionForm key={f.key} kind={f.kind} op={f.op} ref={f.ref} tagColumn={f.tagColumn} currentText={f.currentText} itemId={targets.item_id} heading={f.heading} submitLabel={f.submitLabel} onSubmit={submit} onCancel={() => setOpen(null)} />;
  const note = (kind: TargetKind, ref: string): ReactNode => {
    const c = activeFor(corrections, kind, ref);
    if (!c) return null;
    const m = machineValueOf(c);
    const was = m ? String(m.claim_text ?? m.content_md ?? m.text ?? "") : "";
    return <p role="note" className={styles.muted}><b>{describeCorrection(c)}.</b> Reason: {c.reason}{was ? ` Machine value was: ${clip(was, 160)}` : ""}</p>;
  };
  return (
    <div className={styles.stack}>
      <SectionCard as="section" aria-label={`Corrections to ${targets.title}`}>
        <div className={styles.body}>
          <h1 data-guard-title className={styles.strong}>Corrections to {targets.title}</h1>
          <p className={styles.muted}>{load.state === "loading" ? "Loading corrections..." : load.state === "ready" ? `${counts.active} active, ${counts.revoked} revoked, ${counts.orphaned} orphaned.` : ""}</p>
          {load.state === "error" ? <StateNote tone="error" action={{ label: "Try again", onClick: () => void refresh() }}>{load.message}</StateNote> : null}
          {counts.orphaned > 0 ? <StateNote>{counts.orphaned} {counts.orphaned === 1 ? "correction no longer matches" : "corrections no longer match"} a fact on this item. They are listed under All corrections with what to do.</StateNote> : null}
          {notice ? <StateNote>{notice}</StateNote> : null}
        </div>
      </SectionCard>
      <Block id="corr-facts" title="Facts" hint="Each fact can be hidden from customers or replaced with a source backed one. Nothing is deleted.">
        {targets.facts.length === 0 ? <p className={styles.muted}>This item has no facts that can be corrected.</p> : null}
        {targets.facts.slice(0, facts).map((f) => (
          <div key={f.id} className={styles.rowMain}>
            <span className={`${styles.note} ${styles.wrap}`}>{clip(f.claim_text)}</span>
            {note("fact", f.id)}
            <div className={styles.actions}>
              <Button variant="secondary" size="sm" onClick={() => show({ kind: "fact", op: "suppress", ref: f.id, heading: "Hide this fact from customers", submitLabel: "Hide fact" })}>Hide</Button>
              <Button variant="secondary" size="sm" onClick={() => show({ kind: "fact", op: "replace", ref: f.id, currentText: f.claim_text, heading: "Replace this fact", submitLabel: "Replace fact" })}>Replace</Button>
            </div>
            {open && (isOpen("fact", "suppress", f.id) || isOpen("fact", "replace", f.id)) ? form(open) : null}
          </div>
        ))}
        {targets.facts.length > facts ? <div><Button variant="secondary" size="sm" onClick={() => setFacts((n) => n + PAGE)}>Show more facts ({targets.facts.length - facts} left)</Button></div> : null}
      </Block>
      <Block id="corr-tags" title="Tags">
        {TAG_COLUMNS.map((col) => (
          <div key={col} className={styles.rowMain}>
            <b className={styles.strong}>{columnLabel(col)}</b>
            {targets.tags[col].length === 0 ? <p className={styles.muted}>None on this item.</p> : null}
            {targets.tags[col].map((t) => (
              <div key={t} className={styles.rowMain}>
                <div className={styles.actions}><span className={styles.wrap}>{t}</span><Button variant="secondary" size="sm" onClick={() => show({ kind: "tag", op: "remove", ref: `${col}:${t}`, heading: `Remove the tag ${t}`, submitLabel: "Remove tag" })}>Remove</Button></div>
                {note("tag", `${col}:${t}`)}
                {open && isOpen("tag", "remove", `${col}:${t}`) ? form(open) : null}
              </div>
            ))}
            <div><Button variant="secondary" size="sm" onClick={() => show({ kind: "tag", op: "add", ref: "", tagColumn: col, heading: `Add a tag to ${columnLabel(col).toLowerCase()}`, submitLabel: "Add tag" })}>Add a tag</Button></div>
            {open && isOpen("tag", "add", "", col) ? form(open) : null}
          </div>
        ))}
      </Block>
      <Block id="corr-conn" title="Connections">
        {targets.connections.length === 0 ? <p className={styles.muted}>No connections to other items yet.</p> : null}
        {targets.connections.map((c) => (
          <div key={c.other_item_id} className={styles.rowMain}>
            <span className={styles.wrap}>{relationshipLabel(c.relationship)} {c.other_title}</span>
            {note("connection", c.other_item_id)}
            <div><Button variant="secondary" size="sm" onClick={() => show({ kind: "connection", op: "remove", ref: c.other_item_id, heading: "Remove this connection", submitLabel: "Remove connection" })}>Remove</Button></div>
            {open && isOpen("connection", "remove", c.other_item_id) ? form(open) : null}
          </div>
        ))}
        <div><Button variant="secondary" size="sm" onClick={() => show({ kind: "connection", op: "add", ref: "", heading: "Add a connection to another item", submitLabel: "Add connection" })}>Add a connection</Button></div>
        {open && isOpen("connection", "add", "") ? form(open) : null}
      </Block>
      <Block id="corr-sections" title="Section text">
        {targets.sections.length === 0 ? <p className={styles.muted}>This item has no sections.</p> : null}
        {targets.sections.slice(0, sections).map((s) => (
          <div key={s.section_key} className={styles.rowMain}>
            <b className={styles.strong}>{s.section_key.replace(/_/g, " ")}</b>
            <span className={`${styles.note} ${styles.wrap}`}>{clip(s.content_md)}</span>
            {note("section_text", s.section_key)}
            <div><Button variant="secondary" size="sm" onClick={() => show({ kind: "section_text", op: "replace", ref: s.section_key, currentText: s.content_md, heading: "Replace the text of this section", submitLabel: "Replace section" })}>Replace text</Button></div>
            {open && isOpen("section_text", "replace", s.section_key) ? form(open) : null}
          </div>
        ))}
        {targets.sections.length > sections ? <div><Button variant="secondary" size="sm" onClick={() => setSections((n) => n + PAGE)}>Show more sections ({targets.sections.length - sections} left)</Button></div> : null}
      </Block>
      <Block id="corr-brief" title="Full brief">
        <span className={`${styles.note} ${styles.wrap}`}>{targets.full_brief ? clip(targets.full_brief, 400) : "This item has no full brief."}</span>
        {note("full_brief", "full_brief")}
        <div><Button variant="secondary" size="sm" onClick={() => show({ kind: "full_brief", op: "replace", ref: "full_brief", currentText: targets.full_brief, heading: "Replace the full brief", submitLabel: "Replace brief" })}>Replace brief</Button></div>
        {open && isOpen("full_brief", "replace", "full_brief") ? form(open) : null}
      </Block>
      <section className={styles.stack} aria-labelledby="corr-all">
        <h2 id="corr-all" data-guard-title className={styles.strong}>All corrections</h2>
        {load.state === "ready" && corrections.length === 0 ? <p className={styles.muted}>No corrections have been made on this item. Every value shown is the machine value.</p> : null}
        {newestFirst(corrections).map((c) => <CorrectionRow key={c.id} correction={c} onRevoke={revoke} />)}
      </section>
    </div>
  );
}
