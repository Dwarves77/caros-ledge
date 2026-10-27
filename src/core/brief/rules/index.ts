// New in VALID-1: the rule registry and its runner. data/rules.json names every rule (id, refuse or residue, the formats it applies to, the text scope it reads); this module holds the rule functions by id and refuses to load when the two disagree.
import { z } from "zod";

import { FORMAT_TYPES } from "../contract";
import rulesJson from "../data/rules.json";

import { proseOf } from "./_text";
import type { BriefModel, ItemColumns, Rule, Violation } from "./types";
import dashOutsideVerbatim from "./dash-outside-verbatim";
import workspaceOrClientNamed from "./workspace-or-client-named";
import genericActionPhrase from "./generic-action-phrase";
import tierPhraseExposure from "./tier-phrase-exposure";
import scoreOrSchemaToken from "./score-or-schema-token";
import storedDateStated from "./stored-date-stated";
import whatItChangesLength from "./what-it-changes-length";
import factSpanInOwnSection from "./fact-span-in-own-section";
import doNowSeverityLabel from "./do-now-severity-label";
import sourcesUsedNonEmpty from "./sources-used-non-empty";
import asOfHasDate from "./as-of-has-date";
import requiredSectionsPresent from "./required-sections-present";
import accountingLinePresent from "./accounting-line-present";
import noClaimLedgerJson from "./no-claim-ledger-json";
import pipelineNarration from "./pipeline-narration";
import factSpanInCapture from "./fact-span-in-capture";
import severityInVocabulary from "./severity-in-vocabulary";
import severityPresent from "./severity-present";
import priorityFollowsMap from "./priority-follows-map";
import bannerMatchesColumn from "./banner-matches-column";
import poolOrSlotNarration from "./pool-or-slot-narration";
import noBareUrlInProse from "./no-bare-url-in-prose";
import noHtmlEntityOutsideSpans from "./no-html-entity-outside-spans";
import noIbid from "./no-ibid";
import h1InSectionList from "./h1-in-section-list";
import urgencyTierInVocabulary from "./urgency-tier-in-vocabulary";
import summaryFieldsNonBlank from "./summary-fields-non-blank";
import topicTagsVocabularyAndCap from "./topic-tags-vocabulary-and-cap";
import bandOrThemePresent from "./band-or-theme-present";
import noDoubleHyphenDash from "./no-double-hyphen-dash";
import noSectionSign from "./no-section-sign";
import structuralControls from "./structural-controls";
import forwardEventsCovered from "./forward-events-covered";
import doNowRestatesGap from "./do-now-restates-gap";
import section8LegalCallout from "./section-8-legal-callout";

export type { BriefClaim, BriefModel, ItemColumns, Rule, Violation } from "./types";
export { severityToken } from "./_sev";

const row = z.object({ id: z.string(), severity: z.enum(["refuse", "residue"]), applies_to: z.array(z.enum(FORMAT_TYPES as [string, ...string[]])).min(1), scope: z.enum(["prose", "whole"]) }).strict();
export type RuleRow = z.infer<typeof row>;
export const REGISTRY: readonly RuleRow[] = z.array(row).min(1).parse(rulesJson);

// The rule functions by camelCase file name; the registry id is the kebab-case file name.
const RULES: Readonly<Record<string, Rule>> = Object.fromEntries(
  Object.entries({
  dashOutsideVerbatim, workspaceOrClientNamed, genericActionPhrase, tierPhraseExposure,
  scoreOrSchemaToken, storedDateStated, whatItChangesLength, factSpanInOwnSection,
  doNowSeverityLabel, sourcesUsedNonEmpty, asOfHasDate, requiredSectionsPresent,
  accountingLinePresent, noClaimLedgerJson, pipelineNarration, factSpanInCapture,
  severityInVocabulary, severityPresent, priorityFollowsMap, bannerMatchesColumn,
  poolOrSlotNarration, noBareUrlInProse, noHtmlEntityOutsideSpans, noIbid,
  h1InSectionList, urgencyTierInVocabulary, summaryFieldsNonBlank, topicTagsVocabularyAndCap,
  bandOrThemePresent, noDoubleHyphenDash, noSectionSign, structuralControls, forwardEventsCovered, doNowRestatesGap, "section-8-legal-callout": section8LegalCallout,
  }).map(([name, rule]) => [name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), rule]),
);
/** A rule file with no registry row, or a row with no rule file, fails the import. */
export function assertRegistry(files: readonly string[], rows: readonly RuleRow[]): void {
  for (const id of files) if (!rows.some((r) => r.id === id)) throw new Error(`brief rules: ${id} has a rule file and no row in data/rules.json`);
  for (const r of rows) if (!files.includes(r.id)) throw new Error(`brief rules: data/rules.json names ${r.id} and no rule file holds it`);
}
assertRegistry(Object.keys(RULES), REGISTRY);

/** Run one registered rule: over the prose view or the whole body as its row says (`whole` forces the whole body, the form the register's counts were taken in). */
export function runRule(r: RuleRow, brief: BriefModel, item: ItemColumns, whole = false): Violation | null {
  return (RULES[r.id] as Rule)(r.scope === "prose" && !whole ? { ...brief, body: proseOf(brief) } : brief, item);
}

/**
 * validateBrief(brief, item): every registered rule whose row names the brief's format, run over the brief and the item's columns. `refuse` violations make a claim false or expose internals and block the apply;
 * `residue` violations route the brief to residue with the rule id named. The registry row is the one owner of each rule's severity. It lives here, beside the registry, because the rules hash names with node:crypto
 * and src/core/brief/index.ts (which client code imports) must not reach them.
 */
export function validateBrief(brief: BriefModel, item: ItemColumns): { refuse: Violation[]; residue: Violation[] } {
  const out: { refuse: Violation[]; residue: Violation[] } = { refuse: [], residue: [] };
  for (const r of REGISTRY) {
    const v = r.applies_to.includes(brief.format) ? runRule(r, brief, item) : null;
    if (v) out[r.severity].push(v);
  }
  return out;
}
