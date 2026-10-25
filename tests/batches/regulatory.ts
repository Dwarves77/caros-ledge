// The regulation brief the fixture turn's stub is authored into: the four statutory sentences, the body that carries them under the regulatory format's fifteen sections, the claim records over them, and the trigger that quarantines a brief
// whose figures the held FACT claims do not cover. Shared by the turn test and the FLY-1 wiring test.
import { scanGateA } from "@/core/grounding";

import type { fixture } from "../integration/world.ts";

export const A1 = "This Regulation applies to operators of cargo aircraft and to operators of container vessels calling at Union ports.";
export const A2 = "Operators shall report verified annual emissions to the competent authority before 30 April of each year.";
export const A3 = "A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.";
export const A4 = "This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.";

const HEADS = ["Purpose and Scope of This Document", "What This Regulation Is and Why It Applies to the Workspace", "Issues Requiring Immediate Action", "How the Workspace Sits in the Compliance Chain", "Authoritative Guidance Document Analysis", "Anticipated Authoritative Guidance and Pending Regulatory Events", "Threshold Questions", "Substantive Requirements", "Product-Specific Compliance Status", "Registration and Reporting Obligations", "Operational System Requirements", "Exemptions and Edge Cases", "Adjacent Industry Research and Alternatives", "Confirmed Regulatory Timeline", "Sources"];
const filler = "The reporting calendar belongs in this quarter's planning for every operator concerned, so the owner of the duty should be named early. ";
/** `newSources` is the rows of a "New Sources Identified" table a brief may carry: the sources it cites beyond the pool. */
export function regulatoryBody(newSources = ""): string {
  const req = [A1, A2, A3, "The applicability of the Regulation follows from Article 1, and the due date of the annual report from Article 2.", "*Operational implication:* each operating unit needs an owner for the annual report.", "No phase-in is stated in Articles 1 to 4.", "No exceptions are stated in Articles 1 to 4.", "Obligations surveyed: 3; workspace-adjacent: 3; extracted as FACT: 3."].join("\n\n");
  return HEADS.map((h, i) => `## ${i + 1}. ${h}\n\n${i === 7 ? req : i === 13 ? `- 1 January 2027: ${A4}` : i === 14 ? `- EUR-Lex: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999${newSources ? `

### New Sources Identified

| Source Name | URL |
|---|---|
${newSources}` : ""}` : filler}`).join("\n\n");
}
export const fact = (span: string, section: string, slot?: string) => ({ section, claim_kind: "FACT", claim_text: slot ? `[${slot}] ${span}` : span, source_span: span, source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999", source_id: null, slot_key: slot ?? null });

/** The database trigger that recomputes an item's provenance when its brief changes (set_provenance_status_trg), reduced to the gate that matters here: a new brief whose figures the held FACT claims do not cover is quarantined until it is re-grounded. */
export function installBriefTrigger(f: ReturnType<typeof fixture>): void {
  const prior = f.db.afterWrite;
  f.db.afterWrite = (c, d) => {
    prior?.(c, d);
    const body = c.table === "intelligence_items" && c.op === "update" ? (c.payload as { full_brief?: string } | undefined)?.full_brief : undefined;
    if (!body) return;
    for (const item of d.rows("intelligence_items").filter((r) => r.full_brief === body)) {
      const facts = d.rows("section_claim_provenance").filter((x) => x.intelligence_item_id === item.id && x.claim_kind === "FACT").map((x) => ({ claim_text: String(x.claim_text), source_span: String(x.source_span ?? "") }));
      if (scanGateA(body, facts).orphan_count > 0) item.provenance_status = "quarantined";
    }
  };
}

