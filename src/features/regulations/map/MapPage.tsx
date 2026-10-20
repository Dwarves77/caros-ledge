"use client";

// Ported from old_repo/src/components/map/MapPageView.tsx (lines 40-517)
// The map page: mode, band and region filters over the regulation rows (one jurisdiction model, by ISO code), the Leaflet map, the jurisdiction register (one row per jurisdiction, linking into
// the Regulations list), the Immediate rail, the coverage-gaps rail whose links now work (the old `region-filter` link had no reader) and the legend. A failed coverage read is said, not shown as "no gaps".
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMemo, useState } from "react";

import { TIER1_REGIONS } from "@/core/jurisdictions";
import { BAND_ORDER, bandFromPriority, type UrgencyBandKey } from "@/core/lists";
import { formatNumber } from "@/core/shared";
import { FilterChip, FilterChipGroup, RailCard, SectionCard, SectionHead, StateNote } from "@/ui";
import { LegendRailCard, regionLinkHref } from "@/ui/list-surface";
import { PageFrame } from "@/ui/shell/PageFrame";

import { centroidOf } from "./centroids";
import type { RegionCoverageRead } from "./region-coverage";
import { chipOfKey, jurisdictionKeyOf, REGION_CHIPS, rollup, type MapItem, type RegionChip } from "./rollup";
import { RegisterHeader, RegisterRow } from "./RegisterRow";

const MapView = dynamic(() => import("./MapView").then((m) => m.MapView), { ssr: false, loading: () => <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink-3)", fontSize: 13 }}>Loading map…</div> });

type Mode = "all" | "air" | "road" | "ocean" | "rail";
const MODES: Array<{ key: Mode; label: string }> = [{ key: "all", label: "All" }, { key: "air", label: "Air" }, { key: "road", label: "Road" }, { key: "ocean", label: "Ocean" }, { key: "rail", label: "Rail" }];
const REGISTER_ROW_CAP = 12;
const EU_MEMBERS: ReadonlySet<string> = new Set((TIER1_REGIONS.find((r) => r.id === "eu-members")?.jurisdictions ?? []).map((j) => j.iso));
const plural = (n: number, one: string, many: string) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export function MapPage({ items, coverage, activeCodes }: { items: MapItem[]; coverage: RegionCoverageRead | null; activeCodes: string[] | null }) {
  const [mode, setMode] = useState<Mode>("all");
  const [band, setBand] = useState<UrgencyBandKey | null>(null);
  const [chips, setChips] = useState<Set<RegionChip>>(new Set());
  const [selected, setSelected] = useState<{ key: string | null; nonce: number }>({ key: null, nonce: 0 });
  const focus = (key: string) => setSelected((s) => ({ key: s.key === key ? null : key, nonce: s.nonce + 1 }));

  const scoped = useMemo(() => {
    const codes = activeCodes ? new Set(activeCodes) : null;
    return items.filter((r) => (!codes || (r.jurisdictionIso ?? []).some((c) => codes.has(c.toUpperCase()))) && (band === null || bandFromPriority(r.priority).key === band) && (chips.size === 0 || (((c) => c !== null && chips.has(c))(chipOfKey(jurisdictionKeyOf(r), EU_MEMBERS)))));
  }, [items, activeCodes, band, chips]);
  const shown = useMemo(() => (mode === "all" ? scoped : scoped.filter((r) => r.modes.includes(mode))), [scoped, mode]);
  const modeTags = useMemo(() => ({ tagged: scoped.filter((r) => r.modes.length > 0).length, total: scoped.length }), [scoped]);
  const rows = useMemo(() => rollup(shown), [shown]);
  const charted = rows.filter((r) => centroidOf(r.key));
  const immediate = rows.filter((r) => r.band.key === "immediate");
  const immediateItems = shown.filter((r) => bandFromPriority(r.priority).key === "immediate").length;
  const register = rows.slice(0, REGISTER_ROW_CAP);
  const markers = useMemo(() => charted.flatMap((r) => ((c) => (c ? [{ key: r.key, label: r.label, count: r.count, tone: r.band.key, lat: c[0], lng: c[1] }] : []))(centroidOf(r.key))), [charted]);
  const gaps = [...(coverage?.regions ?? [])].sort((a, b) => b.gap - a.gap || b.partial - a.partial || a.region.name.localeCompare(b.region.name)).slice(0, 5);
  const clear = () => (setBand(null), setChips(new Set()));
  const more = rows.length - register.length;

  return (
    <PageFrame
      rail={
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <RailCard dataAudit="map-immediate-rail" title={`Immediate · ${plural(immediate.length, "jurisdiction", "jurisdictions")}`}>
            {immediate.length === 0 ? (
              <p style={{ fontSize: "var(--fs-12)", color: "var(--ink-2)", margin: 0 }}>No jurisdiction is in the Immediate band for the current filter.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "var(--fs-12)" }}>
                {immediate.slice(0, 6).map((r) => (
                  <div key={r.key} style={{ display: "grid", gridTemplateColumns: "3px 1fr auto", gap: 10, alignItems: "center" }}>
                    <span aria-hidden="true" style={{ background: "var(--immediate)", borderRadius: 2, height: "100%" }} />
                    <span style={{ fontWeight: 600, color: "var(--ink)", minWidth: 0, overflowWrap: "anywhere" }}>{r.label}</span>
                    <span style={{ color: "var(--ink)", fontWeight: 700 }}>{plural(r.count, "immediate item", "immediate items")}</span>
                  </div>
                ))}
              </div>
            )}
          </RailCard>
          <RailCard dataAudit="map-coverage-rail" title="Coverage gaps">
            {coverage === null && <StateNote tone="error">The coverage snapshot did not load, so no coverage count is shown. Reload the page to try again.</StateNote>}
            {coverage !== null && (coverage.notCollected > 0 || coverage.untyped > 0) && (
              <p className="cl-detail-link-note">
                Counts cover collected sources only: {plural(coverage.notCollected, "source is", "sources are")} not yet collected{coverage.untyped > 0 ? ` and ${plural(coverage.untyped, "collected source has", "collected sources have")} no type` : ""}, so {coverage.untyped + coverage.notCollected === 1 ? "it is" : "they are"} not counted.
              </p>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: "var(--fs-12)" }}>
                {(coverage === null ? TIER1_REGIONS.map((region) => ({ region, covered: null as number | null, partial: 0, gap: 0, total: region.jurisdictions.length })) : gaps).map((g) => (
                  <Link key={g.region.id} href={`/map?region=${encodeURIComponent(g.region.id)}`} prefetch={false} aria-label={g.covered === null ? `Filter map to ${g.region.name}` : `Filter map to ${g.region.name} (${g.covered} of ${g.total} jurisdictions covered, ${g.gap} ${g.gap === 1 ? "gap" : "gaps"})`} className="cl-rail-link cl-rail-link--quiet" style={{ display: "flex", justifyContent: "space-between", gap: 10, width: "100%" }}>
                    <span style={{ fontWeight: 600, color: "var(--ink)" }}>{g.region.name}</span>
                    <span style={{ color: "var(--ink-3)", whiteSpace: "nowrap" }}>
                      {g.covered === null ? "—" : `${g.covered} of ${g.total} covered`}
                    </span>
                  </Link>
                ))}
            </div>
          </RailCard>
          <LegendRailCard />
        </div>
      }
    >
      <div data-audit="map-filter-row" style={{ gridColumn: "1 / -1", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "0 4px" }}>
        <FilterChipGroup label="Mode">
          {MODES.map((m) => (
            <FilterChip key={m.key} active={mode === m.key} onClick={() => setMode(m.key)}>
              {m.label}
            </FilterChip>
          ))}
        </FilterChipGroup>
        <FilterChipGroup label="Band">
          <FilterChip active={band === null} onClick={() => setBand(null)}>
            All
          </FilterChip>
          {BAND_ORDER.map((b) => (
            <FilterChip key={b.key} active={band === b.key} onClick={() => setBand(b.key)}>
              {b.label}
            </FilterChip>
          ))}
        </FilterChipGroup>
        <FilterChipGroup label="Region">
          <FilterChip active={chips.size === 0} onClick={() => setChips(new Set())}>
            All
          </FilterChip>
          {REGION_CHIPS.map((c) => (
            <FilterChip key={c} active={chips.has(c)} onClick={() => setChips((s) => (((n) => (n.has(c) ? n.delete(c) : n.add(c), n))(new Set(s))))}>
              {c}
            </FilterChip>
          ))}
        </FilterChipGroup>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }} data-testid="map-register-column">
        {mode !== "all" && (
          <StateNote action={{ label: "Back to all modes", onClick: () => setMode("all") }}>
            Filtering to {MODES.find((m) => m.key === mode)?.label}. Items without a transport-mode tag are hidden while a mode is selected: <strong>{modeTags.tagged}</strong> of {modeTags.total} item{modeTags.total === 1 ? "" : "s"} in the current view {modeTags.tagged === 1 ? "carries" : "carry"} a mode tag.
          </StateNote>
        )}
        <SectionCard>
          <SectionHead title="Regulatory map" aside={`${charted.length} charted of ${rows.length} live · ${formatNumber(charted.reduce((t, r) => t + r.count, 0))} of ${formatNumber(shown.length)} items`} />
          <div style={{ position: "relative", height: 420, overflow: "hidden" }} data-testid="map-canvas" data-guard-clip>
            <div style={{ position: "absolute", inset: 0 }}>
              <MapView markers={markers} selectedKey={selected.key} selectNonce={selected.nonce} onMarkerClick={focus} />
            </div>
          </div>
        </SectionCard>
        <SectionCard>
          <SectionHead title="Jurisdiction register" aside={`${plural(rows.length, "jurisdiction", "jurisdictions")} · open one to see its regulations`} />
          {register.length === 0 ? (
            <div className="cl-pad-16">
              <StateNote action={{ label: "Clear filters", onClick: clear }}>No jurisdictions match this filter.</StateNote>
            </div>
          ) : (
            <div data-testid="jurisdiction-register-rows">
              <RegisterHeader />
              {register.map((r) => (
                <RegisterRow key={r.key} href={regionLinkHref("/regulations", r.codes.length > 0 ? r.codes : [r.key])} band={r.band} code={r.code} label={r.label} themes={r.themes} count={r.count} />
              ))}
            </div>
          )}
          {more > 0 && (
            <p style={{ fontSize: "var(--fs-11)", color: "var(--ink-3)", margin: 0, padding: "var(--sp-14) var(--sp-16)", borderTop: "1px solid var(--line-3)" }}>
              + {plural(more, "more jurisdiction", "more jurisdictions")} · {plural(shown.length - register.reduce((t, r) => t + r.count, 0), "item", "items")} — full register on the{" "}
              <Link href="/regulations" style={{ color: "var(--ink)", fontWeight: 700, padding: "var(--sp-6) 0" }}>
                Regulations index
              </Link>
              .
            </p>
          )}
          {immediateItems > 0 && (
            <div style={{ padding: "0 16px 14px" }}>
              <StateNote band={BAND_ORDER[0] ?? null} action={{ label: "Open the register →", href: "/regulations" }}>
                Immediate · {plural(immediateItems, "item", "items")} bind within 90 days across {plural(immediate.length, "jurisdiction", "jurisdictions")}
              </StateNote>
            </div>
          )}
        </SectionCard>
      </div>
    </PageFrame>
  );
}
