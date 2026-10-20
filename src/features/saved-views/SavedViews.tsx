"use client";

// Ported from old_repo/src/components/settings/SavedSearchesSection.tsx (lines 1-210)
// The saved views of a list (IMP-064): the user's own named list states, applied with one click, saved from the list's current URL state, deleted with one. The views load with the list so the block always says what it
// holds ("No saved views yet." or the count); the disclosure (closed) holds the views and the form. Every failure is said in the view's own words and keeps what was typed.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { Button, FormField, Input, StateNote } from "@/ui";

interface View {
  id: string;
  name: string;
  query: string;
}

export function SavedViews({ surface }: { surface: "regulations" | "market" | "research" | "operations" | "watchlist" }) {
  const router = useRouter();
  const pathname = usePathname();
  const current = useSearchParams().toString();
  const [views, setViews] = useState<View[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ views?: View[] }>(`/api/saved-views?surface=${surface}`).then((r) => {
      if (cancelled) return;
      if (!r.ok) return setProblem(r.error);
      setProblem(null);
      setViews(r.data?.views ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [surface, attempt]);
  async function save() {
    setBusy(true);
    const r = await requestJson<{ view?: View }>("/api/saved-views", { method: "POST", body: { surface, name, query: current } });
    setBusy(false);
    if (!r.ok || !r.data?.view) return setProblem(r.error ?? "That did not save.");
    setProblem(null);
    setName("");
    setViews((v) => [r.data?.view as View, ...(v ?? [])]);
  }
  async function remove(id: string) {
    const r = await requestJson(`/api/saved-views?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) return setProblem(r.error);
    setProblem(null);
    setViews((v) => (v ?? []).filter((x) => x.id !== id));
  }
  return (
    <div style={{ margin: "0 0 12px" }}>
      <details className="cl-detail-disclosure">
        <summary>Saved views{views && views.length > 0 ? ` · ${views.length}` : ""}</summary>
        <div style={{ padding: "8px 0 12px" }}>
          {views !== null && views.length === 0 && <p className="cl-detail-link-note">Choose filters, then name this view to keep it.</p>}
          {(views ?? []).map((v) => (
            <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="cl-detail-link" style={{ flex: 1, textAlign: "left", background: "none", border: "none", font: "inherit", cursor: "pointer" }} onClick={() => router.replace(`${pathname}?${v.query}`, { scroll: false })}>
                <span className="cl-detail-link-title">{v.name}</span>
              </button>
              <Button variant="ghost" aria-label={`Delete the view ${v.name}`} onClick={() => void remove(v.id)}>
                Delete
              </Button>
            </div>
          ))}
          <form
            style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 10, flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <FormField label="Name this view">{(c) => <Input {...c} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />}</FormField>
            <Button type="submit" variant="primary" disabled={busy || !name.trim() || !current}>
              {busy ? "Saving…" : "Save this view"}
            </Button>
          </form>
        </div>
      </details>
      {problem && (
        <StateNote tone="error" action={{ label: "Retry", onClick: () => setAttempt((n) => n + 1) }}>
          {problem}
        </StateNote>
      )}
      {!problem && views === null && <p className="cl-detail-link-note">Loading your saved views…</p>}
      {!problem && views !== null && views.length === 0 && <p className="cl-detail-link-note">No saved views yet.</p>}
    </div>
  );
}
