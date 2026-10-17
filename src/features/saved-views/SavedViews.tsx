"use client";

// Ported from old_repo/src/components/settings/SavedSearchesSection.tsx (lines 1-210)
// The saved views of a list (IMP-064): the user's own named list states, applied with one click, saved from the list's current URL state, deleted with one. A closed disclosure (loads when opened);
// every failure is said in the view's own words and keeps what was typed.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

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
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<View[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const r = await requestJson<{ views?: View[] }>(`/api/saved-views?surface=${surface}`);
    if (!r.ok) return setProblem(r.error);
    setProblem(null);
    setViews(r.data?.views ?? []);
  }
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
    <details
      className="cl-detail-disclosure"
      style={{ margin: "0 0 12px" }}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        setOpen(now);
        if (now && views === null) void load();
      }}
    >
      <summary>Saved views{views && views.length > 0 ? ` · ${views.length}` : ""}</summary>
      {open && (
        <div style={{ padding: "8px 0 12px" }}>
          {problem && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => void load() }}>
              {problem}
            </StateNote>
          )}
          {views === null ? (
            !problem && <p className="cl-detail-link-note">Loading your saved views…</p>
          ) : views.length === 0 ? (
            <p className="cl-detail-link-note">No saved views yet. Choose filters, then name this view to keep it.</p>
          ) : (
            views.map((v) => (
              <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button type="button" className="cl-detail-link" style={{ flex: 1, textAlign: "left", background: "none", border: "none", font: "inherit", cursor: "pointer" }} onClick={() => router.replace(`${pathname}?${v.query}`, { scroll: false })}>
                  <span className="cl-detail-link-title">{v.name}</span>
                </button>
                <Button variant="ghost" aria-label={`Delete the view ${v.name}`} onClick={() => void remove(v.id)}>
                  Delete
                </Button>
              </div>
            ))
          )}
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
      )}
    </details>
  );
}
