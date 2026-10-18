"use client";

// Ported from old_repo/src/components/community/EntityPicker.tsx (lines 45-250)
// Choose the spine entities a thread is about (a corridor, jurisdiction, instrument, technology, organisation), 1 to 10. The candidates come from the entity search route as you type (the old picker was fed a list the page
// had read, and a search round-tripped through the URL). The chosen entities are chips with 44 px remove buttons; the live message is the shared binding validator's. The copy states the rule and no more: a thread belongs to
// the entities it is about, in Community (it does not claim to reach other surfaces).
import { useEffect, useState } from "react";

import { Input } from "@/ui";

import { communityApi } from "../../lib/api";
import { entityBindingMessage, MAX_ENTITY_IDS } from "../../lib/entity-binding";
import { ENTITY_KIND_LABEL } from "../../lib/labels";
import type { EntityRef } from "../../lib/types";
import styles from "../community.module.css";

const DEBOUNCE_MS = 250;

export function EntityPicker({ value, onChange, disabled = false, inputId = "entity-picker-search" }: { value: EntityRef[]; onChange: (next: EntityRef[]) => void; disabled?: boolean; inputId?: string }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<EntityRef[]>([]);
  const [phase, setPhase] = useState<"idle" | "loading" | "failed">("idle");
  const chosen = new Set(value.map((e) => e.entity_id));
  const text = query.trim();

  useEffect(() => {
    if (!text) return;
    let live = true;
    const timer = window.setTimeout(() => {
      setPhase("loading");
      void communityApi.entities(text).then((r) => {
        if (!live) return;
        setPhase(r.ok ? "idle" : "failed");
        setFound(r.ok && r.data ? r.data.entities : []);
      });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [text]);

  const options = text ? found.filter((e) => !chosen.has(e.entity_id)).slice(0, 12) : [];
  const add = (e: EntityRef) => {
    if (value.length >= MAX_ENTITY_IDS || chosen.has(e.entity_id)) return;
    onChange([...value, e]);
    setQuery("");
  };
  const message = value.length === 0 ? entityBindingMessage([]) : null;
  return (
    <div className={styles.picker}>
      <label htmlFor={inputId} className={styles.label}>
        What is this about? Choose 1 to {MAX_ENTITY_IDS} entities <span aria-hidden="true">*</span>
      </label>
      {value.length > 0 && (
        <ul className={styles.chips} aria-label="Chosen entities">
          {value.map((e) => (
            <li key={e.entity_id} className={styles.entityChip}>
              <span className={styles.muted}>{ENTITY_KIND_LABEL[e.kind] ?? e.kind}</span>
              <span>{e.canonical_name}</span>
              {!disabled && (
                <button type="button" className={styles.chipRemove} aria-label={`Remove ${e.canonical_name}`} onClick={() => onChange(value.filter((x) => x.entity_id !== e.entity_id))}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Input id={inputId} type="search" value={query} disabled={disabled || value.length >= MAX_ENTITY_IDS} onChange={(e) => setQuery(e.target.value)} placeholder="Search a corridor, jurisdiction, instrument, technology or organisation" />
      {phase === "loading" && <p className={styles.muted}>Searching…</p>}
      {phase === "failed" && <p role="alert" className={styles.error}>The entity search did not run. Type again to retry.</p>}
      {text && phase === "idle" && options.length === 0 && <p className={styles.muted}>No entity matches &ldquo;{text}&rdquo;.</p>}
      {options.length > 0 && (
        <ul className={styles.options}>
          {options.map((e) => (
            <li key={e.entity_id}>
              <button type="button" className={styles.option} onClick={() => add(e)}>
                <span className={styles.muted}>{ENTITY_KIND_LABEL[e.kind] ?? e.kind}</span>
                <span>{e.canonical_name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p className={styles.muted}>{message}</p>}
    </div>
  );
}
