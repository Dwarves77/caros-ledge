"use client";

import type { ComponentProps } from "react";

import { KIND_LABELS } from "@/features/obligations/kinds";
import { DetailView } from "@/features/regulations/DetailView";
import { MapPage } from "@/features/regulations/map/MapPage";
import { ObligationRegister } from "@/features/regulations/ObligationRegister";
import { RegulationsLedger } from "@/features/regulations/RegulationsLedger";
import type { Resource } from "@/core/types";

const NOW = "2026-10-15T12:00:00.000Z";
const PRIORITIES = ["CRITICAL", "HIGH", "HIGH", "MODERATE", "MODERATE", "LOW"] as const;
const JURISDICTIONS = [["EU"], ["US"], ["GB"], ["DE"], ["CN"], ["BR"]];

const resource = (i: number, over: Partial<Resource> = {}): Resource & { uuid: string } => ({
  id: `fx${i}`,
  uuid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
  cat: i % 2 ? "road" : "ocean",
  sub: "",
  title: `Regulation (EU) 2026/${100 + i} on freight emissions reporting for heavy goods vehicle operators and logistics providers`,
  url: "https://example.test/doc",
  note: "Operators report annually.",
  type: "regulation",
  priority: PRIORITIES[i % PRIORITIES.length] ?? "HIGH",
  added: "2026-09-01",
  reasoning: "",
  tags: ["emissions"],
  whatIsIt: "Annual emissions reporting duties for operators.",
  whyMatters: "Operators must report before 31 March each year.",
  keyData: ["31 March reporting date"],
  domain: 1,
  modes: [i % 2 ? "road" : "ocean"],
  jurisdictionIso: JURISDICTIONS[i % JURISDICTIONS.length] ?? ["EU"],
  jurisdiction: "EU",
  sourceName: "EUR-Lex",
  sourceTier: 1,
  ...over,
});

const ROWS = Array.from({ length: 14 }, (_, i) => resource(i + 1));
const SECTION_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"];
const S3 = "**ACTION REQUIRED** Register with the competent authority.\n\nOperators shall submit a verified annual emissions report to the competent authority before 31 March of each year. Source: EUR-Lex, Regulation 2023/9999, 2026 https://eur-lex.europa.eu/doc";
const sections = SECTION_KEYS.map((k, i) => ({ id: `cccccccc-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, section_key: k, section_order: i + 1, content_md: k === "3" ? S3 : `Section ${k}. Operators shall submit a verified annual emissions report to the competent authority before 31 March of each year.`, is_conditional: false, item_id: "x" }));
const BRIEF = ["## 15. Sources", "| Source Name | Tier | URL |", "|---|---|---|", "| EUR-Lex | Tier 1 | https://eur-lex.europa.eu/doc |"].join("\n");
const DETAIL: ComponentProps<typeof DetailView> = {
  resource: resource(1, { fullBrief: BRIEF, compliance_deadline: "2027-01-01", sourceUrl: "https://eur-lex.europa.eu/doc" } as Partial<Resource>),
  changelog: [{ date: "2026-05-01", type: "UPDATED", field: "x", impact: "Reporting now covers rail operators." } as never],
  dispute: null,
  sections,
  claimTiers: {},
  recommendedActions: [],
  crossPage: { intersections: null, theme: null, inferences: null, degraded: [] },
  connectionRows: [],
  events: [{ event_date: "2027-01-01", event_kind: "entry_into_force" }],
  eventsFailed: false,
  kindLabels: KIND_LABELS,
  hasWorkspace: true,
  nowIso: NOW,
};
const REGISTER = { total: 2, rows: [
  { id: "r1", jurisdiction: ["EU"], modes: ["road"], binding_position: "duty", due_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force", obligation_text: "Report annual emissions", item: { id: "fx1", title: "Regulation (EU) 2026/101", legacy_id: "fx1" } },
  { id: "r2", jurisdiction: ["US"], modes: ["ocean"], binding_position: null, due_date: null, date_precision: null, event_kind: "compliance_deadline", obligation_text: null, item: { id: "fx2", title: "Rule 2026-7", legacy_id: "fx2" } },
] };

/** One Regulations screen per `?screen=`, with static props; the data it reads arrives from the smoke's mocked responses. */
export function RegulationsFixtures({ screen }: { screen: string }) {
  return (
    <div data-fx="regulations">
      {screen === "ledger" ? (
        <RegulationsLedger initial={ROWS} aggregates={{ totalItems: ROWS.length, byPriority: { CRITICAL: 3, HIGH: 5, MODERATE: 4, LOW: 2 }, byStatus: {}, byJurisdiction: { EU: 6, US: 4 }, totalJurisdictions: 6, lastUpdatedAt: NOW }} hasMore={false} nowIso={NOW} chips={[]} rail={null} />
      ) : null}
      {screen === "detail" ? <DetailView {...DETAIL}>{null}</DetailView> : null}
      {screen === "record" ? <DetailView {...DETAIL} resource={{ ...DETAIL.resource, itemGrade: "record", fullBrief: "" }} sections={[]}>{null}</DetailView> : null}
      {screen === "register" ? <ObligationRegister variant="list" initial={REGISTER} failed={false} jurisdictions={["EU", "US"]} modes={["road", "ocean"]} /> : null}
      {screen === "map" ? <MapPage items={ROWS.map((r) => ({ id: r.id, title: r.title, priority: r.priority, modes: r.modes ?? [], jurisdictionIso: r.jurisdictionIso ?? []}))} coverage={null} activeCodes={null} /> : null}
    </div>
  );
}
