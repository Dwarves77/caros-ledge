"use client";

// Ported from old_repo/src/components/admin/corrections/CorrectionForm.tsx (lines 50-172)
import { useState } from "react";

import { Button, FormField, Input, Select, Textarea } from "@/ui";

import styles from "../ui/admin.module.css";

import { ItemSearchPicker } from "./ItemSearchPicker";
import { EDGE_RELATIONSHIPS, relationshipLabel, valueFor, type Draft } from "./model";
import type { CorrectionOp, TargetKind } from "./types";

export type FormDraft = Draft;
interface Props {
  kind: TargetKind;
  op: CorrectionOp;
  /** The target ref, or "" when the form builds it (tag add: column plus typed tag; connection add: picked item). */
  ref: string;
  tagColumn?: string | undefined;
  currentText?: string | undefined;
  itemId: string;
  heading: string;
  submitLabel: string;
  onSubmit: (draft: Draft) => Promise<{ ok: boolean; message?: string }>;
  onCancel: () => void;
}

/** One override form: the fields the action needs, a required reason, and a refusal shown beside the control with the input kept. It builds the target and the value; the model validates the body. */
export function CorrectionForm(p: Props) {
  const [text, setText] = useState(p.currentText ?? "");
  const [claim, setClaim] = useState(p.kind === "fact" ? (p.currentText ?? "") : "");
  const [span, setSpan] = useState("");
  const [capture, setCapture] = useState("");
  const [tag, setTag] = useState("");
  const [picked, setPicked] = useState<{ id: string; title: string } | null>(null);
  const [relationship, setRelationship] = useState("related");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTag = p.kind === "tag" && p.op === "add";
  const addEdge = p.kind === "connection" && p.op === "add";
  const blocked = addTag && !tag.trim() ? "Type the tag to add." : addEdge && !picked ? "Pick the related item first." : "";
  const submit = async () => {
    setPending(true);
    setError(null);
    const ref = addTag ? `${p.tagColumn ?? ""}:${tag.trim()}` : addEdge ? (picked?.id ?? "") : p.ref;
    const value = addEdge ? valueFor("connection", "add", { relationship }) : p.kind === "fact" && p.op === "replace" ? valueFor("fact", "replace", { claim_text: claim, source_span: span, search_result_id: capture }) : p.kind === "section_text" ? valueFor("section_text", "replace", { content_md: text }) : p.kind === "full_brief" ? valueFor("full_brief", "replace", { text }) : null;
    const out = await p.onSubmit({ kind: p.kind, op: p.op, ref, value, reason });
    setPending(false);
    if (!out.ok) setError(out.message ?? "The correction did not go through. Your input is kept. Try again.");
  };
  return (
    <div role="group" aria-label={p.heading} className={styles.detail}>
      <b className={styles.strong}>{p.heading}</b>
      {p.kind === "fact" && p.op === "suppress" ? <p className={styles.note}>This hides the fact from customers everywhere it shows. Nothing is deleted, and revoking brings it back.</p> : null}
      {p.kind === "fact" && p.op === "replace" ? (
        <>
          <FormField label="Corrected claim text" hint="Optional: leave it to keep the wording.">{(c) => <Textarea {...c} rows={3} value={claim} onChange={(e) => setClaim(e.target.value)} disabled={pending} />}</FormField>
          <FormField label="Source span, copied word for word from the source" required>{(c) => <Textarea {...c} rows={3} value={span} onChange={(e) => setSpan(e.target.value)} disabled={pending} />}</FormField>
          <FormField label="Capture id the span comes from" required>{(c) => <Input {...c} value={capture} onChange={(e) => setCapture(e.target.value)} disabled={pending} />}</FormField>
        </>
      ) : null}
      {addTag ? <FormField label="Tag to add" required>{(c) => <Input {...c} value={tag} onChange={(e) => setTag(e.target.value)} disabled={pending} />}</FormField> : null}
      {addEdge ? (
        <>
          {picked ? <p className={styles.note}>Connect to: <b>{picked.title}</b> <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>Choose another</Button></p> : <ItemSearchPicker label="Find the related item" excludeIds={[p.itemId]} onPick={setPicked} />}
          <FormField label="How they are related">{(c) => <Select {...c} value={relationship} onChange={(e) => setRelationship(e.target.value)} disabled={pending}>{EDGE_RELATIONSHIPS.map((r) => <option key={r} value={r}>{relationshipLabel(r)}</option>)}</Select>}</FormField>
        </>
      ) : null}
      {p.kind === "section_text" || p.kind === "full_brief" ? <FormField label={p.kind === "section_text" ? "New section text" : "New full brief"} required>{(c) => <Textarea {...c} rows={8} value={text} onChange={(e) => setText(e.target.value)} disabled={pending} />}</FormField> : null}
      <FormField label="Reason" required>{(c) => <Textarea {...c} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending} />}</FormField>
      {blocked ? <p className={styles.muted}>{blocked}</p> : null}
      {error ? <p role="alert" className={styles.note}>{error}</p> : null}
      <div className={styles.actions}>
        <Button variant="primary" size="sm" disabled={pending || blocked !== ""} onClick={submit}>{pending ? "Saving..." : p.submitLabel}</Button>
        <Button variant="secondary" size="sm" disabled={pending} onClick={p.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
