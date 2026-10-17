// Barrel: the research family's import surface (new in P2-07).
export { aggregateAuthorityDistribution, authorityScore, bucketForSource, classifyRoleClass, scoreSource } from "./authority-score";
export { fetchLiveCandidates, researchAssessment } from "./assessment-producer";
export { assessItem, hasChanged, toAssessmentInput, toRow } from "./model/assess";
export { classifyTheme, classifyThemes, THEME_VALUES, UNCLASSIFIED } from "./theme-rules";
export { boundNeeds, buildMintSeed, normalizeOpenAlexWork, placePublisher, researchWalker, walkResearch } from "./walker";
export type { WalkerDeps } from "./walker";
