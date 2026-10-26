// The validator report's fixture set (VALID-1, INV-VAL-5): one clean brief per format, the exempt twins of the dash rule, and one planted violation per rule, each row labelled with the rules it must trip.
// The plants are the register's own samples (docs/audits/VALIDATOR-RULES-STEP-A-2026-10-25.md section 3) where production has one; the rest are built from the rule's definition. The report script
// (scripts/ci/validator-report.mjs --fixture) fails when a row trips another set than its label or a rule trips on no row; tests/brief/rules/<rule>.test.ts reads its plant and its clean twin from here.
import { FORMATS, TOPIC_TAGS } from "@/core/brief";
import type { BriefClaim, BriefModel, ItemColumns } from "@/core/brief/rules";

export interface Row { id: string; trips: string[]; brief: BriefModel; item: ItemColumns }
interface Patch { format?: string; sec?: Record<string, string>; drop?: string[]; prefix?: string; claims?: BriefClaim[]; item?: Partial<ItemColumns> }

const MARKET = "market_signal_brief";
const REGULATORY = "regulatory_fact_document";
// Long enough that the labelled do-now section sits past the 600 characters a banner may occupy.
const PAD = "Operators of cargo aircraft and container vessels face a new annual reporting duty, and the reporting calendar belongs in this quarter's planning for every operator concerned. ".repeat(4);
const SECTIONS: Record<string, Record<string, string>> = {
  [MARKET]: {
    "1": `${PAD}Carriers announced a surcharge that changes how forwarders price air freight this quarter.`,
    "2": "Airlines and handlers push the surcharge on to forwarders.",
    "3": "Forwarders expect the surcharge to apply from the next tariff cycle.\n\n- 1 January 2027: the surcharge applies.",
    "4": "Every air quote now needs a surcharge line, which raises the cost of each consignment.",
    "7": "COST ALERT: Add the surcharge line to every air quote before the next tariff cycle.",
    "8": "- Carrier notice: https://example.org/carrier-notice",
  },
  [REGULATORY]: {
    "1": `${PAD}This Regulation sets an annual reporting duty for cargo operators.`,
    "2": "The workspace reports as an operator of cargo aircraft.",
    "3": "COST ALERT: Name an owner for the annual report this quarter.",
    "4": "The reporting duty sits with each operating unit.",
    "8": "Operators submit an annual report.\n\nNo phase-in is stated in Articles 1 to 4.\nNo exceptions are stated in Articles 1 to 4.\nNo scope limits are stated in Articles 1 to 4.\nObligations surveyed: 0; workspace-adjacent: 0; extracted as FACT: 0.",
    "10": "Each operating unit files one report.",
    "11": "COST ALERT: Register each operating unit with the competent authority.",
    "14": "- 1 January 2027: entry into force.",
    "15": "- Act text: https://example.org/act",
  },
};
const heading = (format: string, key: string): string => FORMATS.find((f) => f.formatType === format)?.sections.find((s) => s.key === key)?.heading ?? key;
const COLUMNS: ItemColumns = {
  severity: "cost_alert", priority: "HIGH", urgency_tier: "elevated", entry_into_force: null, compliance_deadline: null,
  what_it_changes: "Adds a surcharge line to every air quote, so quotes issued before the next tariff cycle must carry the new cost and its start date.",
  what_is_it: "A carrier surcharge on air freight.", why_matters: "Quotes that omit the surcharge lose margin.", topic_tags: [TOPIC_TAGS[0] as string, TOPIC_TAGS[1] as string],
  sources_used: ["b0000000-0000-4000-8000-000000000001"], signal_band: "price", theme: null, format_type: MARKET, pool_chars: 5000, has_trajectory: false,
};

function make(id: string, trips: string[], p: Patch = {}): Row {
  const format = p.format ?? MARKET;
  const secs = { ...SECTIONS[format], ...p.sec };
  for (const k of p.drop ?? []) delete secs[k];
  const keys = Object.keys(secs).sort((a, b) => Number(a) - Number(b));
  const body = `${p.prefix ?? ""}${keys.map((k) => `## ${k}. ${heading(format, k)}\n\n${secs[k]}`).join("\n\n")}`;
  const item = { ...COLUMNS, format_type: format, signal_band: format === MARKET ? "price" : null, ...p.item };
  return { id, trips, brief: { body, format, sections: new Map(Object.entries(secs)), claims: p.claims ?? [], exempt: [] }, item };
}
const fact = (section: string, span: string, capture: string, text = span): BriefClaim => ({ kind: "FACT", section, span, text, capture });
const SPAN = "Allowances shall be allocated as follows: — 15 % shall be auctioned";
const one = (rule: string, p: Patch): Row => make(rule, [rule], p);

export const ROWS: Row[] = [
  make("clean-market", []),
  make("clean-regulatory", [], { format: REGULATORY }),
  // R1's exemption, both ways (INV-VAL-4): a dash inside a guillemet run or inside a FACT claim's source_span passes; a dash in a claim's own text, outside its span, is refused.
  make("exempt-dash-guillemets", [], { sec: { "4": `Every air quote needs a surcharge line. «${SPAN}»` } }),
  make("exempt-dash-fact-span", [], { sec: { "2": `Airlines push the surcharge on. ${SPAN}.` }, claims: [fact("2", SPAN, `The text reads: ${SPAN}.`, "A share of allowances is auctioned")] }),
  make("dash-in-claim-text-outside-span", ["dash-outside-verbatim"], { sec: { "2": "The cap — set at 15 % — applies to forwarders. Airlines push the surcharge on." }, claims: [fact("2", "Airlines push the surcharge on.", "Airlines push the surcharge on.", "The cap — set at 15 % — applies to forwarders.")] }),
  make("exempt-entity-guillemets", [], { sec: { "4": "Every air quote needs a surcharge line. «of the Council&nbsp; ( 68 ) , respectively.»" } }),
  one("dash-outside-verbatim", { prefix: "# U.S. Energy Information Administration Short-Term Energy Outlook — May 2026\n\n" }),
  one("workspace-or-client-named", { sec: { "2": "Zorblax Quillfeather commissions crate fabrication on behalf of clients." } }),
  one("generic-action-phrase", { sec: { "7": "COST ALERT: Clients with California Scope 2 disclosure obligations should be aware of the reporting date." } }),
  one("tier-phrase-exposure", { sec: { "4": "**Note on source tier:** The primary enacted text of MARPOL Annex VI is the 2021 consolidated edition." } }),
  one("score-or-schema-token", { sec: { "4": "The intelligence_items.item_type enum has no 'decision' value." } }),
  one("stored-date-stated", { item: { compliance_deadline: "2030-01-01" } }),
  one("what-it-changes-length", { item: { what_it_changes: "Adds a deadline." } }),
  one("fact-span-in-own-section", { sec: { "2": "Airlines push the surcharge on. The surcharge starts with the next tariff cycle." }, claims: [fact("1", "The surcharge starts with the next tariff cycle.", "The surcharge starts with the next tariff cycle.")] }),
  one("do-now-severity-label", { sec: { "7": "FACT: \"This Regulation shall enter into force on the twentieth day following that of its publication in the Official Journal of the European Union\"" } }),
  one("sources-used-non-empty", { item: { sources_used: [] } }),
  one("as-of-has-date", { sec: { "2": "This document reflects source content available as of the date of generation." } }),
  one("required-sections-present", { drop: ["4"] }),
  one("accounting-line-present", { format: REGULATORY, sec: { "8": "Operators submit an annual report.\n\nNo phase-in is stated in Articles 1 to 4.\nNo exceptions are stated in Articles 1 to 4.\nNo scope limits are stated in Articles 1 to 4." } }),
  one("no-claim-ledger-json", { sec: { "4": "\"claim_kind\": \"FACT\", \"source_span\": \"Signed into law in July 2019 and became effective on January 1, 2020.\"" } }),
  make("pipeline-narration", ["pipeline-narration", "pool-or-slot-narration"], { sec: { "2": "Source URLs used in FACT citations are drawn exclusively from this item's captured pool." } }),
  one("fact-span-in-capture", { sec: { "2": "Airlines push the surcharge on. The surcharge starts with the next tariff cycle." }, claims: [fact("2", "The surcharge starts with the next tariff cycle.", "A different source text altogether.")] }),
  one("severity-in-vocabulary", { item: { severity: "reference", priority: "LOW" } }),
  one("severity-present", { item: { severity: null } }),
  one("priority-follows-map", { item: { severity: "monitoring", priority: "HIGH" } }),
  one("banner-matches-column", { prefix: "## COST ALERT | MONITORING\n\n", item: { severity: "monitoring", priority: "LOW" } }),
  one("pool-or-slot-narration", { sec: { "2": "Shortfall: none, and the 6,607-character pool is well under the 200,000-character large-pool threshold, so the forced five-claim floor does not apply." } }),
  one("no-bare-url-in-prose", { sec: { "4": "Every air quote needs a surcharge line (https://deq.wyoming.gov/shwd/solid-waste/coal-combustion-residual-ccr/)." } }),
  one("no-html-entity-outside-spans", { sec: { "4": "Every air quote needs a line of the Council&nbsp; ( 68 ) , respectively." } }),
  one("no-ibid", { sec: { "3": "Forwarders expect the surcharge to apply. *Source: ibid.*" } }),
  one("h1-in-section-list", { prefix: "# Carrier surcharge on air freight\n\n", sec: { "4": "Every air quote needs a surcharge line.\n\n# Appendix of loose notes" } }),
  one("urgency-tier-in-vocabulary", { item: { urgency_tier: null } }),
  one("summary-fields-non-blank", { item: { why_matters: "  " } }),
  one("topic-tags-vocabulary-and-cap", { item: { topic_tags: ["fashion"] } }),
  one("band-or-theme-present", { item: { signal_band: null } }),
  one("no-double-hyphen-dash", { sec: { "2": "Shortfall: none -- K equals M." } }),
  one("no-section-sign", { sec: { "4": "Every air quote needs a surcharge line (42 U.S.C. §6945)." } }),
  one("structural-controls", { sec: { "4": "| Carrier | Surcharge |\n|---|---|\n| Air | |" } }),
];
