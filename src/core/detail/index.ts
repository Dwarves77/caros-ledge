// New in P2-10 (barrel): the detail architecture every surface imports.
export { readClaims, readFactSuppressionsFor } from "./claim-tiers";
export { readCrossPage, readThemeChips } from "./cross-page-read";
export type { CrossPage } from "./cross-page-read";
export { deriveFactCardModels, deriveRecordFactCardModel, mergeAdjacentSameKind, parseFactParagraphs } from "./fact-model";
export type { FactParagraph } from "./fact-model";
export { itemIdColumn, resolveIdRedirect } from "./id-redirect";
export type { IdRedirectDecision, IdRedirectRow } from "./id-redirect";
export { pickVisibleInferences, readCustomerInferences } from "./inference-view";
export type { InferenceClaimView, InferenceView } from "./inference-view";
export { readDetailItem } from "./item-read";
export type { DetailRead, SectionRow } from "./item-read";
export { applyIdRedirect, loadDetail } from "./load";
export type { DetailBundle, ItemScopedCtx } from "./load";
export { CONNECTED_SECTION_ID, crossPageOrd, indexFor, INFERENCES_SECTION_ID, SECTION_INDEX } from "./section-index";
export { sourceEntriesOf } from "./sources-parse";
export type { SourceRow } from "./sources-parse";
export { formatTrajectoryStep, pickCurrentStepIndex, withObligationEvents } from "./timeline";
export { withClaimTiers } from "@/ui/claim-tier";
