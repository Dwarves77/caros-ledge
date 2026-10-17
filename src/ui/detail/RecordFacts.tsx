// Ported from old_repo/src/components/detail/primitives.tsx (lines 30-126)
// Ported from old_repo/src/components/regulations/RegulationDetailSurface.tsx (lines 537-604)
import type { ReactNode } from "react";

import { deriveRecordFactCardModel } from "@/core/detail/fact-model";
import type { RecordFactRow } from "@/core/brief";

import { Absence } from "../Absence";
import { TagChip } from "../Chips";
import { FactCard } from "../FactCard";
import { ItemGroup } from "../ItemGroup";
import { SectionLabel } from "../SectionLabel";
import { StateNote } from "../StateNote";

export function RecordFactCard({ fact }: { fact: RecordFactRow }) {
  const model = fact.kind === "FACT" ? deriveRecordFactCardModel(fact) : null;
  if (model) return <FactCard model={model} />;
  return (
    <p style={{ fontSize: "var(--fs-13)", lineHeight: 1.6, color: "var(--ink-2)", margin: "0 0 8px" }}>
      <strong style={{ color: "var(--ink-3)" }}>{fact.label}:</strong> {fact.text || <Absence reason="not in primary source" />}
    </p>
  );
}

/** A record-grade item's body: the lead note, key dates, verbatim facts (or the absence), an optional gaps line, the tags. */
export function RecordFacts({ leadNote, dateFacts, otherFacts, gapsLine, tags }: { leadNote: ReactNode; dateFacts: RecordFactRow[]; otherFacts: RecordFactRow[]; gapsLine?: ReactNode; tags?: readonly string[] | null }) {
  return (
    <>
      <StateNote>{leadNote}</StateNote>
      {dateFacts.length > 0 && (
        <ItemGroup title="Key dates">
          {dateFacts.map((f) => <RecordFactCard key={f.slotKey} fact={f} />)}
        </ItemGroup>
      )}
      {otherFacts.length > 0 ? (
        <ItemGroup title="Verbatim facts">
          {otherFacts.map((f) => <RecordFactCard key={f.slotKey} fact={f} />)}
        </ItemGroup>
      ) : (
        <div style={{ margin: "14px 0" }}>
          <SectionLabel>Verbatim facts</SectionLabel>
          <Absence reason="not in primary source" />
        </div>
      )}
      {gapsLine && <p style={{ fontSize: "var(--fs-12)", color: "var(--ink-2)", margin: "8px 0 0" }}>{gapsLine}</p>}
      {tags && tags.length > 0 && (
        <div className="cl-filter-group-chips" style={{ marginTop: 8 }}>
          {tags.map((t) => <TagChip key={t}>{t}</TagChip>)}
        </div>
      )}
    </>
  );
}
