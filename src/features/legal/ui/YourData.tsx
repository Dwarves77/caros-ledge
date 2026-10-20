"use client";

// New in R2e (M5): the controls that honour the access, portability and deletion rights from the privacy page. Download my data fetches GET /api/account/export and saves the file; Delete my account asks first, says what
// happens, needs the phrase typed, calls DELETE /api/account, and sends the member to the sign-in page. A signed-out visitor is told to sign in; a refusal shows its sentence (a sole owner of a shared organisation is told who to
// make an owner first). Every control is a kit part, at least 44 px.
import { useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { DELETE_PHRASE } from "@/features/auth/lib/account-phrase";
import { Button, Dialog, FormField, Input, StateNote } from "@/ui";

const ROW = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" } as const;
const COLUMN = { display: "flex", flexDirection: "column", gap: 12 } as const;

export function YourData() {
  const [status, setStatus] = useState<{ tone: "note" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");

  async function download() {
    setBusy(true);
    setStatus(null);
    const r = await requestJson<unknown>("/api/account/export");
    setBusy(false);
    if (!r.ok) return setStatus({ tone: "error", text: r.status === 401 ? "Sign in to download your data." : "Your data could not be prepared just now. Try again in a moment." });
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "caros-ledge-account-export.json";
    link.click();
    URL.revokeObjectURL(url);
    setStatus({ tone: "note", text: "Your data was downloaded as caros-ledge-account-export.json." });
  }
  async function remove() {
    setBusy(true);
    const r = await requestJson("/api/account", { method: "DELETE", body: { confirm: DELETE_PHRASE } });
    setBusy(false);
    if (!r.ok) {
      setAsking(false);
      return setStatus({ tone: "error", text: r.status === 401 ? "Sign in to delete your account." : (r.error ?? "Your account could not be deleted.") });
    }
    window.location.assign("/login");
  }
  return (
    <div style={ROW}>
      <Button variant="secondary" disabled={busy} onClick={() => void download()}>{busy && !asking ? "Preparing…" : "Download my data"}</Button>
      <Button variant="danger" disabled={busy} onClick={() => { setTyped(""); setAsking(true); }}>Delete my account</Button>
      {status && <StateNote tone={status.tone}>{status.text}</StateNote>}
      <Dialog open={asking} onClose={() => (busy ? undefined : setAsking(false))} title="Delete your account">
        <div style={COLUMN}>
          <p>This deletes your account, your profile, your memberships and your personal records. What you wrote in Community stays and is shown as written by a deleted member. A workspace only you belong to is deleted with you. It cannot be undone.</p>
          <FormField label={`Type "${DELETE_PHRASE}" to confirm`}>{(c) => <Input {...c} value={typed} onChange={(e) => setTyped(e.target.value)} />}</FormField>
          <Button variant="secondary" disabled={busy} onClick={() => setAsking(false)}>Keep my account</Button>
          <Button variant="danger" disabled={busy || typed.trim().toLowerCase() !== DELETE_PHRASE} onClick={() => void remove()}>{busy ? "Deleting…" : "Delete my account"}</Button>
        </div>
      </Dialog>
    </div>
  );
}
