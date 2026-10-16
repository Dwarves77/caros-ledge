"use client";

// Ported from old_repo/src/components/ui/TagPopover.tsx (lines 44-392)
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { WorkspaceTagPill } from "@/ui";

import { attributionText, type TagApplication } from "../attribution-text";

import { clampHighlight, moveHighlight, resolveBackspaceAction, resolveEnterAction, rowCount, showCreateRow, visibleRows, type TagOption } from "./tag-model";
import { createTag, fetchItemTags, setTagApplied } from "./tags-client";
import styles from "./workspace.module.css";

const PANEL_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

/**
 * The "+ Tag" popover: search, apply and remove (multi-select, it stays open), create, and who applied each tag. The caller's action row owns the one
 * trigger and passes `open`; this part is the anchored panel. Escape and an outside press close it and focus returns to what opened it. Every apply,
 * remove and create result is shown: a refusal never passes for a success (B-0215).
 */
export function TagPopover({ itemId, open, onOpenChange, onChange }: { itemId: string; open: boolean; onOpenChange: (open: boolean) => void; onChange?: () => void }) {
  const [tags, setTags] = useState<TagOption[]>([]);
  const [appliedOrder, setAppliedOrder] = useState<string[]>([]);
  const [applications, setApplications] = useState<TagApplication[]>([]);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  // Horizontal shift (<= 0 px) that keeps the 280 px panel inside the viewport at phone width.
  const [shiftX, setShiftX] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const applied = useMemo(() => new Set(appliedOrder), [appliedOrder]);
  const rows = useMemo(() => visibleRows(tags, query), [tags, query]);
  const showCreate = showCreateRow(tags, query);
  const total = rowCount(tags, query);
  const [prevTotal, setPrevTotal] = useState(total);
  if (prevTotal !== total) {
    setPrevTotal(total);
    setHighlight((h) => clampHighlight(h, total));
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetchItemTags(itemId).then((r) => {
      if (cancelled) return;
      setLoading(false);
      if (!r.ok) return setProblem(r.error);
      setProblem(null);
      setTags(r.tags.map((t) => ({ id: t.id, name: t.name, itemCount: t.itemCount })));
      setAppliedOrder(r.appliedTagIds);
      setApplications(r.applications);
    });
    return () => {
      cancelled = true;
    };
  }, [open, itemId, reload]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onOpenChange(false);
    };
    const fit = () => {
      const left = root.current?.getBoundingClientRect().left ?? 0;
      const overflow = left + PANEL_WIDTH + 2 + VIEWPORT_MARGIN - window.innerWidth;
      setShiftX(overflow > 0 ? -Math.min(overflow, Math.max(0, left - VIEWPORT_MARGIN)) : 0);
    };
    fit();
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", fit);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", fit);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, onOpenChange]);

  async function apply(tagId: string, on: boolean) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const error = await setTagApplied(tagId, itemId, on);
    if (error) setProblem(error);
    else {
      setAppliedOrder((prev) => (on ? [...prev, tagId] : prev.filter((id) => id !== tagId)));
      if (on) setReload((n) => n + 1);
      onChange?.();
    }
    setBusy(false);
  }

  async function createAndApply(name: string) {
    if (busy || !name) return;
    setBusy(true);
    setProblem(null);
    const { tag: created, error: createError } = await createTag(name);
    if (!created) setProblem(createError);
    else {
      setTags((prev) => (prev.some((t) => t.id === created.id) ? prev : [...prev, { id: created.id, name: created.name, itemCount: created.itemCount }]));
      const error = await setTagApplied(created.id, itemId, true);
      if (error) setProblem(error);
      else {
        setAppliedOrder((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
        setQuery("");
        setReload((n) => n + 1);
        onChange?.();
      }
    }
    setBusy(false);
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") return void (e.preventDefault(), onOpenChange(false));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") return void (e.preventDefault(), setHighlight((h) => moveHighlight(h, e.key === "ArrowDown" ? 1 : -1, total)));
    if (e.key === "Enter") {
      e.preventDefault();
      const action = resolveEnterAction(tags, query, highlight);
      if (action.type === "toggle") void apply(action.tagId, !applied.has(action.tagId));
      else if (action.type === "create") void createAndApply(action.name);
    } else if (e.key === "Backspace") {
      const action = resolveBackspaceAction(query, appliedOrder);
      if (action.type === "removeLast") {
        e.preventDefault();
        void apply(action.tagId, false);
      }
    }
  }

  return (
    <div ref={root} className={styles.tagAnchor}>
      {open ? (
        <div role="listbox" aria-label="Workspace tags" aria-busy={loading} onKeyDown={onKeyDown} className={styles.tagPanel} style={{ left: shiftX }}>
          <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find or create a tag" aria-label="Find or create a tag" aria-autocomplete="list" className={styles.tagSearch} />
          {problem ? (
            <p role="alert" className={styles.tagProblem}>
              {problem}{" "}
              <button type="button" className={styles.inlineButton} onClick={() => (setLoading(true), setReload((n) => n + 1))}>
                Retry
              </button>
            </p>
          ) : null}
          <div className={styles.tagRows}>
            {rows.map((tag, i) => {
              const on = applied.has(tag.id);
              const note = on ? attributionText(applications.find((a) => a.tagId === tag.id)) : null;
              return (
                <div key={tag.id} role="option" aria-selected={on} tabIndex={-1} data-highlight={highlight === i} onMouseEnter={() => setHighlight(i)} onClick={() => void apply(tag.id, !on)} className={styles.tagRow}>
                  <span className={styles.tagName}>
                    <WorkspaceTagPill name={tag.name} />
                    {note ? (
                      <span title={note} className={styles.tagNote}>
                        {note}
                      </span>
                    ) : null}
                  </span>
                  {on ? <span aria-hidden="true">✓</span> : <span className={styles.tagCount}>{tag.itemCount}</span>}
                </div>
              );
            })}
            {showCreate ? (
              <div role="option" aria-selected={false} tabIndex={-1} data-highlight={highlight === rows.length} onMouseEnter={() => setHighlight(rows.length)} onClick={() => void createAndApply(query.trim())} className={`${styles.tagRow} ${styles.tagCreate}`}>
                <span>Create &ldquo;{query.trim()}&rdquo;</span>
                <WorkspaceTagPill name={query.trim()} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
