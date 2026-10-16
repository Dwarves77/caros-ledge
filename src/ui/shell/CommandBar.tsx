"use client";

// Ported from old_repo/src/components/ui/CommandBar.tsx (lines 118-776)
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { authedFetch } from "@/core/http/authed-fetch";
import { bandFromPriority, detailHref, jurisdictionCode, metaLine } from "@/core/lists";
import { formatNumber } from "@/core/shared";

import { SkeletonListRow } from "../Skeleton";
import { StateNote } from "../StateNote";
import { ListRow } from "../ListRow";

import { useBootstrapStore } from "./use-bootstrap";
import { activeDescendantId, clearButtonLabel, clearButtonVisible, isOutsidePointerDown, moveActiveIndex, optionId, resolveEnterKeyAction, runSearch, searchResultsHref, type SearchState } from "./command-bar";

const AssistantContext = createContext(false);
/** Whether an assistant surface is mounted: the shell command bar enables Ask only then. The Ask event is the one the assistant surface listens for. */
export const AssistantProvider = ({ mounted, children }: { mounted: boolean; children: ReactNode }) => <AssistantContext.Provider value={mounted}>{children}</AssistantContext.Provider>;

const DEBOUNCE_MS = 250;
const MIN_QUERY = 2;

interface CommandBarProps {
  itemCount: number | null;
  placeholder?: string;
  /** Sends the same text to the assistant; absent when no assistant is mounted or enabled: Ask is still drawn, disabled with its reason (the old bar did the same; the control is on every signed-in page). */
  onAsk?: (text: string, anchor: { top: number; left: number; width: number } | null) => void;
  onSearch?: (query: string) => void;
}

/** The one bar: typing searches, Enter opens the results page, Ask sends the same text. A failed search says so and offers Retry; it never reads as "No results". */
export function CommandBar({ itemCount, placeholder, onAsk, onSearch }: CommandBarProps) {
  const router = useRouter();
  const listboxId = `cl-cb-${useId()}`;
  const [value, setValue] = useState("");
  const [state, setState] = useState<SearchState>({ phase: "idle" });
  const [retry, setRetry] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const q = value.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.length < MIN_QUERY) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ phase: "loading" });
      void runSearch(authedFetch, q, ctl.signal).then((s) => !ctl.signal.aborted && (setState(s), setActive(-1)));
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [q, retry]);

  const open = !dismissed && q.length >= MIN_QUERY && state.phase !== "idle";
  const rows = useMemo(() => (state.phase === "ok" ? state.rows : []), [state]);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const r = form.current?.getBoundingClientRect();
      if (r) setRect({ top: r.bottom + 6, left: r.left, width: r.width });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (isOutsidePointerDown(!!(t && form.current?.contains(t)), !!(t && panel.current?.contains(t)))) setDismissed(true);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  const ask = () => q && onAsk?.(q, form.current ? (({ bottom, left, width }) => ({ top: bottom, left, width }))(form.current.getBoundingClientRect()) : null);
  const clear = () => {
    input.current?.focus();
    if (value) {
      setValue("");
      setState({ phase: "idle" });
      onSearch?.("");
    }
    setDismissed(true);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setDismissed(true);
    } else if (e.key === "Enter") {
      const action = resolveEnterKeyAction(e.metaKey || e.ctrlKey, active);
      if (action === "ask" && onAsk) {
        e.preventDefault();
        ask();
      } else if (action === "navigate-active") {
        e.preventDefault();
        document.getElementById(optionId(listboxId, active))?.querySelector<HTMLAnchorElement>("a.cl-row-link")?.click();
      }
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open && rows.length > 0) {
      e.preventDefault();
      setActive((i) => moveActiveIndex(i, e.key === "ArrowDown" ? 1 : -1, rows.length));
    }
  };

  return (
    <form ref={form} role="search" data-part="command-bar" className="cl-command-bar" onSubmit={(e) => (e.preventDefault(), q && router.push(searchResultsHref(q)))}>
      <span aria-hidden="true" className="cl-search-glyph">
        ⌕
      </span>
      <input
        id="cl-command-bar-input"
        ref={input}
        value={value}
        onChange={(e) => (setValue(e.target.value), onSearch?.(e.target.value), setDismissed(false), e.target.value.trim().length < MIN_QUERY && setState({ phase: "idle" }))}
        onFocus={() => setDismissed(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? (itemCount != null ? `Search or ask across ${formatNumber(itemCount)} items…` : "Search or ask across the workspace…")}
        aria-label="Search or ask across the workspace"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open ? activeDescendantId(listboxId, active) : undefined}
        className="cl-command-bar-input"
      />
      {clearButtonVisible(value.length > 0, open) && (
        <button type="button" onClick={clear} aria-label={clearButtonLabel(value.length > 0)} className="cl-command-bar-clear">
          ×
        </button>
      )}
      <span aria-hidden="true" className="cl-cmdk-hint">
        ⌘K
      </span>
      <button type="button" className="cl-command-bar-ask-submit" onClick={ask} disabled={!onAsk} aria-disabled={!onAsk} title={onAsk ? undefined : "The Assistant is currently unavailable."}>
        Ask
      </button>
      {open &&
        rect &&
        createPortal(
          <div ref={panel} className="cl-command-bar-panel" style={{ top: rect.top, left: rect.left, width: rect.width }}>
            <button type="button" className="cl-command-bar-panel-close" onClick={() => (input.current?.focus(), setDismissed(true))}>
              <span aria-hidden="true">×</span> Close
            </button>
            <div id={listboxId} role="listbox" aria-label="Search results" className="cl-narrow-box cl-command-bar-list">
              {state.phase === "loading" ? (
                <>
                  <SkeletonListRow />
                  <SkeletonListRow />
                  <SkeletonListRow />
                </>
              ) : state.phase === "failed" ? (
                <div className="cl-command-bar-note">
                  <StateNote tone="error" action={{ label: "Retry", onClick: () => setRetry((n) => n + 1) }}>
                    Search is unavailable right now. Nothing was lost; try again.
                  </StateNote>
                </div>
              ) : rows.length === 0 ? (
                <div className="cl-command-bar-note">
                  <StateNote>No results for “{q}”.</StateNote>
                </div>
              ) : (
                rows.map((r, i) => (
                  <div key={r.id} id={optionId(listboxId, i)} role="option" aria-selected={i === active} onMouseMove={() => active !== i && setActive(i)} className={i === active ? "cl-command-bar-opt cl-command-bar-opt--on" : "cl-command-bar-opt"}>
                    <ListRow href={detailHref({ id: r.id, type: r.item_type, domain: r.domain })} band={bandFromPriority(r.priority)} jurisdiction={jurisdictionCode({ jurisdiction: r.jurisdictions?.[0] ?? undefined })} title={r.title} meta={metaLine({ type: r.item_type, modes: r.transport_modes ?? undefined, topic: r.topic ?? undefined })} />
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </form>
  );
}

/** The command bar a surface drops into the Masthead slot: item count from the nav counts, Ask wired to the assistant event when one is mounted and enabled. */
export function ShellCommandBar({ placeholder }: { placeholder?: string }) {
  const mounted = useContext(AssistantContext);
  const enabled = useBootstrapStore((s) => s.data?.assistantEnabled === true);
  const counts = useBootstrapStore((s) => s.data?.navCounts ?? null);
  const parts = counts ? [counts.regulations, counts.market, counts.research, counts.operations] : [];
  const total = parts.length === 4 && parts.every((n) => n !== null) ? (parts as number[]).reduce((a, b) => a + b, 0) : null;
  const onAsk = mounted && enabled ? (question: string, anchor: { top: number; left: number; width: number } | null) => window.dispatchEvent(new CustomEvent("open-ask-assistant", { detail: { question, anchor } })) : undefined;
  return <CommandBar itemCount={total} {...(placeholder ? { placeholder } : {})} {...(onAsk ? { onAsk } : {})} />;
}
