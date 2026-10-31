"use client";

// New in UI-RADAR-1 (scripts/ci/new-files/ui-radar-1.txt): the customer face of the flywheel's cross-surface findings and of the structured rows tied to an item. Three presentational parts over views the server composed (src/features/flywheel/radar/read.ts, the
// sentences of src/core/flywheel/view-model.ts): the radar (each pattern in plain words, what it joins by surface, what would confirm it, which part of the chain is missing, the connections still developing), the two-line "Why this matters" under a figure,
// and the "What moves with this" rows of a detail page. Every string is a sentence; no method id, uuid, score or tag reaches this file.
import Link from "next/link";
import { useRouter } from "next/navigation";

import { refusalSentence } from "@/core/http/failure";

import { DetailSubSection } from "../ItemGroup";
import { StateNote } from "../StateNote";

// the views the server composes (src/features/flywheel/radar/read.ts) and this panel draws
export interface RadarGroup {
  surface: string;
  label: string;
  /** The surface's own page, so a group with no item of its own is still a link. */
  href: string;
  items: { title: string; href: string }[];
  /** The entities the findings on this surface are filed under, by their canonical names. */
  names: string[];
}
export interface RadarPattern {
  key: string;
  label: string;
  /** What it means to the reader; the pattern's own sentence, or the family name while the chain is forming. */
  means: string;
  forming: boolean;
  groups: RadarGroup[];
  watch: string | null;
  missingParts: string[];
  next: string | null;
}
export interface RadarForming {
  key: string;
  family: string | null;
  chain: { title: string; href: string; surface: string }[];
  reason: string;
  next: string | null;
}
export interface RadarView {
  patterns: RadarPattern[];
  forming: RadarForming[];
}

const RADAR_EMPTY = "No cross-surface pattern has formed yet in this scope.";

/** The radar of one scope; null is a read that failed (the panel says so with Retry), an empty view is the honest empty state. `quiet` draws nothing for an empty view (an item with no pattern). */
export function FlywheelRadar({ view, variant = "section", quiet = false }: { view: RadarView | null; variant?: "section" | "inline"; quiet?: boolean }) {
  const router = useRouter();
  if (view !== null && quiet && view.patterns.length === 0 && view.forming.length === 0) return null;
  const body =
    view === null ? (
      <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>{refusalSentence("radar_unavailable")}</StateNote>
    ) : view.patterns.length === 0 && view.forming.length === 0 ? (
      <StateNote>{RADAR_EMPTY}</StateNote>
    ) : (
      <div className="cl-conn-grid">
        {view.patterns.map((p) => (
          <div key={p.key} className="cl-detail-link" data-part="radar-pattern" data-forming={p.forming ? "true" : undefined}>
            <p className="cl-detail-label" style={{ margin: 0 }}>{p.label}</p>
            <p className="cl-detail-link-context">{p.means}</p>
            {p.groups.map((g) => (
              <p key={g.surface} className="cl-detail-link-note">
                <Link href={g.href} prefetch={false} className="cl-detail-link-tap">{g.label}</Link>:{" "}
                {g.items.map((it, i) => (
                  <span key={it.href}>{i > 0 ? " · " : ""}<Link href={it.href} prefetch={false} className="cl-detail-link-tap">{it.title}</Link></span>
                ))}
                {g.items.length === 0 ? g.names.join(" · ") : ""}
              </p>
            ))}
            {p.watch && <p className="cl-detail-link-note">{p.watch}</p>}
            {p.next && <p className="cl-detail-link-note">Next link to watch: {p.next}</p>}
            {p.missingParts.map((m) => (
              <p key={m} className="cl-detail-link-note">{m}</p>
            ))}
          </div>
        ))}
        {view.forming.map((f) => (
          <div key={f.key} className="cl-detail-link" data-part="radar-forming" data-forming="true">
            <p className="cl-detail-label" style={{ margin: 0 }}>{f.family ?? "Connection forming"}</p>
            <p className="cl-detail-link-context">{f.reason}</p>
            <p className="cl-detail-link-note">
              {f.chain.map((c, i) => (
                <span key={c.href}>{i > 0 ? " · " : ""}<Link href={c.href} prefetch={false} className="cl-detail-link-tap">{c.title}</Link></span>
              ))}
            </p>
            {f.next && <p className="cl-detail-link-note">Next link to watch: {f.next}</p>}
          </div>
        ))}
      </div>
    );
  const count = view ? view.patterns.length + view.forming.length : 0;
  if (variant === "inline") {
    return (
      <div className="cl-detail-block" data-audit="flywheel-radar">
        <p className="cl-detail-label">Cross-surface patterns</p>
        {body}
      </div>
    );
  }
  return (
    <section className="cl-themes" data-audit="flywheel-radar">
      <div className="cl-themes-head">
        <h2 className="cl-themes-title">Cross-surface patterns</h2>
        {count > 0 && <span className="cl-themes-count">{count} found</span>}
      </div>
      {body}
    </section>
  );
}

/** Under a figure: two lines saying which rule and which operation it reaches. */
export function WhyMatters({ lines }: { lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <div data-part="why-matters">
      <p className="cl-detail-label" style={{ margin: 0 }}>Why this matters</p>
      {lines.map((l) => (
        <p key={l} className="cl-detail-link-note">{l}</p>
      ))}
    </div>
  );
}

/** The structured rows tied to the item's entities, each with its consequence in one line. */
export function MovesWith({ rows, first }: { rows: readonly { kind: string; line: string }[]; first?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <DetailSubSection title="What moves with this" subtitle="Figures and rules tied to the same entities as this item" first={first ?? false}>
      <div className="cl-conn-grid">
        {rows.map((r) => (
          <div key={r.line} className="cl-detail-link" data-part="moves-with">
            <p className="cl-detail-label" style={{ margin: 0 }}>{r.kind}</p>
            <p className="cl-detail-link-context">{r.line}</p>
          </div>
        ))}
      </div>
    </DetailSubSection>
  );
}
