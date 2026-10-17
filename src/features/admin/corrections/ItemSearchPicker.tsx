"use client";

// Ported from old_repo/src/components/admin/corrections/ItemSearchPicker.tsx (lines 26-118)
import { useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import { Button, FormField, Input } from "@/ui";

import styles from "../ui/admin.module.css";

const MIN_CHARS = 3;
interface Hit {
  id: string;
  title: string;
}

/** Find an item by title through the platform search (three letters or more, debounced); results leave out `excludeIds`. A failed search says so and asks to type again. */
export function ItemSearchPicker({ label, excludeIds = [], onPick }: { label: string; excludeIds?: string[]; onPick: (item: Hit) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Hit[]>([]);
  const [state, setState] = useState<"idle" | "searching" | "done" | "error">("idle");
  useEffect(() => {
    const text = q.trim();
    if (text.length < MIN_CHARS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the search is the synchronisation with the server
      setState("idle");
      setRows([]);
      return;
    }
    let live = true;
    setState("searching");
    const timer = setTimeout(async () => {
      const r = await requestJson<{ results?: Hit[] }>(`/api/search?q=${encodeURIComponent(text)}`);
      if (!live) return;
      setRows(r.ok && Array.isArray(r.data?.results) ? r.data.results : []);
      setState(r.ok ? "done" : "error");
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);
  const shown = rows.filter((r) => !excludeIds.includes(r.id)).slice(0, 8);
  return (
    <div className={styles.stack}>
      <FormField label={label}>{(c) => <Input {...c} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least three letters of the title" />}</FormField>
      {state === "searching" ? <p className={styles.muted}>Searching...</p> : null}
      {state === "error" ? <p role="alert" className={styles.note}>The search did not go through. Check the connection and type again.</p> : null}
      {state === "done" && shown.length === 0 ? <p className={styles.muted}>No items match. Try other words from the title.</p> : null}
      {shown.map((r) => <Button key={r.id} variant="secondary" size="sm" onClick={() => onPick({ id: r.id, title: r.title })}>{r.title}</Button>)}
    </div>
  );
}
