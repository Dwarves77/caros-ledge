"use client";

// Ported from old_repo/src/components/AskAssistant.tsx (lines 63-227, 235-528)
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import { bandFromPriority } from "@/core/lists";
import { authedFetch } from "@/core/http/authed-fetch";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import { tierLabelOf } from "@/core/sources";
import { Button, Input, ListRow, SourceLink, StateNote } from "@/ui";
import { OPEN_ASK_EVENT } from "@/ui/shell/command-bar";

import type { AskHit, AskResponse } from "../types";

import styles from "./assistant.module.css";

type Anchor = { top: number; left: number; width: number } | null;
type Turn = { question: string; result: { ok: true; answer: AskResponse } | { ok: false; error: string } | null };
const GUTTER = 16;
const PANEL_MAX = 768;

const placement = (a: Anchor): CSSProperties => {
  const width = Math.min(Math.max(a?.width ?? 0, 360), PANEL_MAX);
  if (!a) return { top: 72, left: "50%", transform: "translateX(-50%)", width: `min(calc(100vw - ${GUTTER * 2}px), ${PANEL_MAX}px)` };
  return { top: Math.round(a.top + 8), left: Math.round(Math.max(GUTTER, Math.min(a.left, window.innerWidth - width - GUTTER))), width };
};
const when = (iso: string | null): string => (iso && !Number.isNaN(new Date(iso).getTime()) ? formatLocaleDate(new Date(iso), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : "");

function Hit({ h }: { h: AskHit }) {
  const s = h.source;
  const cited = s?.citationCount != null ? `cited by ${formatNumber(s.citationCount)} ${s.citationCount === 1 ? "item" : "items"}` : null;
  return (
    <div className={styles.hit}>
      <ListRow href={h.href} band={bandFromPriority(h.priority)} jurisdiction={h.jurisdiction} title={h.title} meta={h.meta} tier={h.tier} />
      <details className={styles.more}>
        <summary>Source and excerpt</summary>
        <div className={styles.moreBody}>
          {h.summary && <p className={styles.text}>{h.summary}</p>}
          {h.excerpt && <p className={styles.meta}>{h.excerpt}</p>}
          {h.intersection && <p className={styles.meta}>{h.intersection}</p>}
          {h.relatedCount > 0 && <p className={styles.meta}>{formatNumber(h.relatedCount)} related {h.relatedCount === 1 ? "item" : "items"} on the platform.</p>}
          {s && (
            <p className={styles.meta}>
              Source: {s.name ?? "not named"}
              {h.tier != null ? ` (${tierLabelOf(h.tier)})` : ""}
              {cited ? ` · ${cited}` : ""}
              {s.recency ? ` · latest ${when(s.recency)}` : ""}
              {s.url ? <> · <SourceLink href={s.url}>Open the source</SourceLink></> : null}
            </p>
          )}
        </div>
      </details>
    </div>
  );
}

function Answer({ a }: { a: AskResponse }) {
  return (
    <div className={styles.reply}>
      {a.empty && <StateNote>The platform holds nothing matching that question. Refine it, or use the search bar.</StateNote>}
      {a.answers.length > 0 && (
        <section>
          <p className={styles.label}>Answers on record</p>
          {a.answers.map((x) => (
            <div key={`${x.itemId}:${x.question}`} className={styles.card}>
              <p className={styles.q}>{x.question}</p>
              <p className={styles.text}>{x.text}</p>
              <p className={styles.meta}>
                Inference · {x.statusToken}
                {x.confidence != null ? ` · confidence ${Math.round(x.confidence * 100)}%` : ""} · on {x.itemTitle}
              </p>
              {x.cited.map((c) => (
                <a key={c.id} href={c.href} className={styles.cited}>
                  {c.title}
                </a>
              ))}
            </div>
          ))}
        </section>
      )}
      {a.hits.length > 0 && (
        <section>
          <p className={styles.label}>Platform items · {formatNumber(a.hits.length)}</p>
          <div className="cl-narrow-box">
            {a.hits.map((h) => (
              <Hit key={h.id} h={h} />
            ))}
          </div>
        </section>
      )}
      {a.passages.map((p) => (
        <section key={p.id} className={styles.card}>
          <p className={styles.label}>From the platform guide · {p.heading}</p>
          <p className={styles.text}>{p.text}</p>
        </section>
      ))}
      {a.operations.length > 0 && (
        <section>
          <p className={styles.label}>Operations data</p>
          <ul className={styles.lines}>
            {a.operations.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}
      <p className={styles.fine}>{a.disclaimer}</p>
    </div>
  );
}

/** The Assistant: opened by the command bar's Ask. A research helper that shows what the platform holds on the question, with each item's source rating, the answers a session wrote to its standard questions and the platform guide. It names only what it read. */
export function AskAssistant() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const field = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.result === null);

  const ask = useCallback(async (raw: string, replace?: number) => {
    const question = raw.trim();
    if (question.length < 2) return;
    setInput("");
    setTurns((t) => (replace === undefined ? [...t, { question, result: null }] : t.map((x, i) => (i === replace ? { question, result: null } : x))));
    let result: Turn["result"];
    try {
      const res = await authedFetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) });
      const data: unknown = await res.json().catch(() => null);
      result = res.ok && data && typeof data === "object" ? { ok: true, answer: data as AskResponse } : { ok: false, error: (data as { error?: string } | null)?.error ?? "The Assistant could not answer just now. Try again." };
    } catch {
      result = { ok: false, error: "The Assistant could not be reached. Check your connection and try again." };
    }
    setTurns((t) => t.map((x) => (x.question === question && x.result === null ? { question, result } : x)));
  }, []);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ question?: string; anchor?: Anchor }>).detail;
      setAnchor(d?.anchor ?? null);
      setOpen(true);
      if (d?.question) void ask(d.question);
    };
    window.addEventListener(OPEN_ASK_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ASK_EVENT, onOpen);
  }, [ask]);
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [turns]);

  const close = () => {
    setOpen(false);
    document.getElementById("cl-command-bar-input")?.focus();
  };
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Intelligence Assistant" className={styles.panel} style={placement(anchor)} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className={styles.head}>
        <h2 className={styles.title}>Intelligence Assistant</h2>
        <button type="button" className={styles.close} aria-label="Close assistant" onClick={close}>
          ×
        </button>
      </div>
      <div className={styles.body} role="log" aria-live="polite">
        {turns.length === 0 && <p className={styles.intro}>Ask about freight sustainability. I show what the platform holds on it: regulations, market signals, research and jurisdictional operations data, each with where it comes from. I help you find what is relevant; you make the decision.</p>}
        {turns.map((t, i) => (
          <div key={`${i}:${t.question}`} className={styles.reply}>
            <div className={styles.asked}>{t.question}</div>
            {t.result === null ? (
              <p className={styles.intro}>Looking...</p>
            ) : t.result.ok ? (
              <Answer a={t.result.answer} />
            ) : (
              <StateNote tone="error" action={{ label: "Try again", onClick: () => void ask(t.question, i) }}>
                {t.result.error}
              </StateNote>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className={styles.compose} onSubmit={(e) => (e.preventDefault(), void ask(input))}>
        <Input ref={field} aria-label="Ask the Assistant" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask a question" maxLength={500} autoComplete="off" />
        <Button type="submit" variant="primary" disabled={busy || input.trim().length < 2}>
          Ask
        </Button>
      </form>
    </div>
  );
}
