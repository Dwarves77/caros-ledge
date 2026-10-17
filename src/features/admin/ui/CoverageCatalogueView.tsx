"use client";

// Ported from old_repo/src/components/admin/CoverageCatalogueView.tsx (lines 40-153)
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { FormField, Select, EmptyState } from "@/ui";

import { Load, Panel, useAdminFetch } from "./panel-kit";
import styles from "./admin.module.css";

type Identity = "verified" | "unresolved" | "dead" | "pending";
interface Entry {
  id: string;
  url: string;
  identifier: string | null;
  displayTitle: string;
  jurisdiction: string | null;
  instrumentType: string | null;
  scheme: string | null;
  surfaces: string[];
  relevance: "firm" | "soft";
  identity: Identity;
}
const SURFACES = [{ key: "", label: "All surfaces" }, { key: "regulations", label: "Regulations" }, { key: "operations", label: "Operations" }, { key: "market_intel", label: "Market Intel" }, { key: "research", label: "Research" }];
const IDENTITY_WORDS: Record<Identity, string> = { verified: "Resolves", pending: "Check pending", unresolved: "Unconfirmed", dead: "Not reachable" };
const SCHEMES: Record<string, string> = { celex: "CELEX", eli: "ELI", "uk-legislation": "UK-SI", generic: "ref", none: "URL" };
export const DISPLAY_CAP = 200;
type Sort = "relevance" | "title" | "jurisdiction" | "type" | "identity";
const RANK: Record<Identity, number> = { verified: 0, pending: 1, unresolved: 2, dead: 3 };
const SORTS: Record<Sort, (a: Entry, b: Entry) => number> = {
  relevance: (a, b) => (a.relevance !== b.relevance ? (a.relevance === "firm" ? -1 : 1) : RANK[a.identity] - RANK[b.identity]),
  title: (a, b) => a.displayTitle.localeCompare(b.displayTitle),
  jurisdiction: (a, b) => (a.jurisdiction || "~").localeCompare(b.jurisdiction || "~"),
  type: (a, b) => (a.instrumentType || "~").localeCompare(b.instrumentType || "~"),
  identity: (a, b) => RANK[a.identity] - RANK[b.identity],
};

/** The entries after the filters and the sort (the list is cut to 200 for the screen, and the cut is said). Pure. */
export function viewOf(entries: readonly Entry[], f: { jurisdiction: string; type: string; relevance: string; identity: string; sort: Sort }): Entry[] {
  return entries.filter((e) => (!f.jurisdiction || e.jurisdiction === f.jurisdiction) && (!f.type || e.instrumentType === f.type) && (!f.relevance || e.relevance === f.relevance) && (!f.identity || e.identity === f.identity)).sort(SORTS[f.sort]);
}

/** The catalogue behind the coverage numbers: every catalogued instrument with its relevance and whether its identifier resolves. Filter and sort; the primary source is one tap away. */
export function CoverageCatalogueView() {
  const [surface, setSurface] = useState("");
  const [f, setF] = useState({ jurisdiction: "", type: "", relevance: "", identity: "", sort: "relevance" as Sort });
  const q = useAdminFetch<{ entries: Entry[] }>(`/api/coverage/entries${surface ? `?surface=${surface}` : ""}`);
  const pick = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  return (
    <Panel title="Catalogue" aside={q.data ? `${formatNumber(q.data.entries.length)} catalogued` : undefined} onRefresh={q.reload}>
      <Load q={q} what="The catalogue">
        {(d) => {
          const view = viewOf(d.entries, f);
          const uniq = (pickFn: (e: Entry) => string | null) => [...new Set(d.entries.map(pickFn).filter(Boolean))].sort() as string[];
          return (
            <>
              <p className={styles.note}>{formatNumber(d.entries.filter((e) => e.relevance === "firm" && e.identity === "verified").length)} dual-verified · firm {formatNumber(d.entries.filter((e) => e.relevance === "firm").length)} · soft {formatNumber(d.entries.filter((e) => e.relevance === "soft").length)}</p>
              <div className={styles.grid3}>
                <FormField label="Surface">{(c) => <Select {...c} value={surface} onChange={(e) => setSurface(e.target.value)}>{SURFACES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select>}</FormField>
                <FormField label="Jurisdiction">{(c) => <Select {...c} value={f.jurisdiction} onChange={pick("jurisdiction")}><option value="">All jurisdictions</option>{uniq((e) => e.jurisdiction).map((j) => <option key={j} value={j}>{j}</option>)}</Select>}</FormField>
                <FormField label="Type">{(c) => <Select {...c} value={f.type} onChange={pick("type")}><option value="">All types</option>{uniq((e) => e.instrumentType).map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}</Select>}</FormField>
                <FormField label="Relevance">{(c) => <Select {...c} value={f.relevance} onChange={pick("relevance")}><option value="">Firm and soft</option><option value="firm">Firm core</option><option value="soft">Soft tail</option></Select>}</FormField>
                <FormField label="Identity">{(c) => <Select {...c} value={f.identity} onChange={pick("identity")}><option value="">Any identity</option>{(Object.keys(IDENTITY_WORDS) as Identity[]).map((i) => <option key={i} value={i}>{IDENTITY_WORDS[i]}</option>)}</Select>}</FormField>
                <FormField label="Sort">{(c) => <Select {...c} value={f.sort} onChange={pick("sort")}>{(Object.keys(SORTS) as Sort[]).map((s) => <option key={s} value={s}>{s}</option>)}</Select>}</FormField>
              </div>
              <p className={styles.muted}>Showing {formatNumber(Math.min(view.length, DISPLAY_CAP))} of {formatNumber(view.length)} matching (all {formatNumber(d.entries.length)} loaded).</p>
              {view.length === 0 ? <EmptyState>No catalogued instrument matches these filters.</EmptyState> : null}
              {view.slice(0, DISPLAY_CAP).map((e) => (
                <div key={e.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <b className={`${styles.strong} ${styles.wrap}`}>{e.displayTitle}</b>
                    <span className={styles.chips}>
                      <span className={styles.pill}>{SCHEMES[e.scheme ?? "none"] ?? "ref"}</span>
                      {e.identifier ? <span className={styles.mono}>{e.identifier}</span> : null}
                      {e.jurisdiction ? <span className={styles.pill}>{e.jurisdiction}</span> : null}
                      {e.instrumentType ? <span className={styles.pill}>{e.instrumentType.replace(/_/g, " ")}</span> : null}
                      {e.surfaces.map((s) => <span key={s} className={styles.pill}>{s.replace("_", " ")}</span>)}
                      {e.relevance === "soft" ? <span className={styles.pill}>low relevance</span> : null}
                    </span>
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className={styles.link}>Primary source</a>
                  </div>
                  <span className={e.identity === "verified" ? styles.pillOk : e.identity === "dead" ? styles.pillBad : styles.pill}>{IDENTITY_WORDS[e.identity]}</span>
                </div>
              ))}
            </>
          );
        }}
      </Load>
    </Panel>
  );
}
