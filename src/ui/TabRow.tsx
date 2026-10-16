"use client";

// Ported from old_repo/src/components/ui/TabRow.tsx (lines 28-130)
import Link from "next/link";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { wrapIndex } from "./focus";

export interface TabRowItem {
  key: string;
  label: ReactNode;
  active?: boolean;
  href?: string;
  onClick?: () => void;
}

/** Tabs as links (`nav`) or in-page tabs (`tablist`, roving tabindex with Arrow, Home and End). Every tab is 44 px tall. */
export function TabRow({ tabs, ariaLabel, placement = "page", semantics = "nav" }: { tabs: TabRowItem[]; ariaLabel: string; placement?: "page" | "card-head"; semantics?: "nav" | "tablist" }) {
  const row = useRef<HTMLDivElement | null>(null);
  const tablist = semantics === "tablist";
  const activeKey = tabs.find((t) => t.active)?.key ?? tabs[0]?.key;
  const onKeyDown = (e: KeyboardEvent) => {
    if (!tablist) return;
    const nodes = Array.from(row.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    const target = e.key === "ArrowRight" ? wrapIndex(nodes.length, at, 1) : e.key === "ArrowLeft" ? wrapIndex(nodes.length, at, -1) : e.key === "Home" ? 0 : e.key === "End" ? nodes.length - 1 : -1;
    if (target < 0) return;
    e.preventDefault();
    nodes[target]?.focus();
  };
  const body = tabs.map((t) =>
    t.href ? (
      <Link key={t.key} href={t.href} prefetch={false} aria-current={t.active ? "page" : undefined} className={`cl-tab${t.active ? " cl-tab--active" : ""}`}>
        {t.label}
      </Link>
    ) : (
      <button
        key={t.key}
        type="button"
        role={tablist ? "tab" : undefined}
        aria-selected={tablist ? !!t.active : undefined}
        aria-current={tablist ? undefined : t.active ? "page" : undefined}
        tabIndex={tablist ? (t.key === activeKey ? 0 : -1) : undefined}
        onClick={t.onClick}
        className={`cl-tab${t.active ? " cl-tab--active" : ""}`}
      >
        {t.label}
      </button>
    ),
  );
  const cls = `cl-tabrow${placement === "card-head" ? " cl-tabrow--card" : ""}`;
  return tablist ? (
    <div ref={row} role="tablist" aria-label={ariaLabel} className={cls} onKeyDown={onKeyDown}>
      {body}
    </div>
  ) : (
    <nav aria-label={ariaLabel} className={cls}>
      {body}
    </nav>
  );
}
