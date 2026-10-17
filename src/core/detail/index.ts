// New in P2-10 (barrel): the detail architecture every surface imports.
export { buildClaimTierMap, fetchClaimTierMap, readClaims, readFactSuppressions, readFactSuppressionsFor } from "./claim-tiers";
export { readCrossPage, readFreshInferences, readThemeChips, readThemes, readVerifiedItemsByIds } from "./cross-page-read";
export type { CrossPage } from "./cross-page-read";
export { deriveFactCardModels, deriveRecordFactCardModel, mergeAdjacentSameKind, parseFactCardModels, parseFactParagraphs, toClaimNodes } from "./fact-model";
export type { FactParagraph } from "./fact-model";
export { admittedSurfaceFor, decideIdRedirect, ID_REDIRECT_COLUMNS, isItemUuid, itemIdColumn, resolveIdRedirect } from "./id-redirect";
export type { IdRedirectDecision, IdRedirectRow } from "./id-redirect";
export { currentInferenceRows, CUSTOMER_INFERENCE_METHOD_IDS, MAX_VISIBLE_INFERENCES, pickVisibleInferences, questionInWords, readCustomerInferences, restrictToVisibleCitations, selectCurrentInferences } from "./inference-view";
export type { InferenceClaimView, InferenceView } from "./inference-view";
export { readDetailItem } from "./item-read";
export type { DetailRead, SectionRow } from "./item-read";
export { applyIdRedirect, loadDetail } from "./load";
export type { DetailBundle, ItemScopedCtx } from "./load";
export { CONNECTED_SECTION_ID, crossPageOrd, indexFor, INFERENCES_SECTION_ID, SECTION_INDEX } from "./section-index";
export { sourceEntriesOf } from "./sources-parse";
export type { SourceRow } from "./sources-parse";
export { classifyTimeline, collapseTimeline, formatTrajectoryStep, mergeObligationEvents, nextMilestoneClause, pickCurrentStepIndex, withObligationEvents } from "./timeline";
export { resolveClaimTier, withClaimTiers } from "@/ui/claim-tier";
