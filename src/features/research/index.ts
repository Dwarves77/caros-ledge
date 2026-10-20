// Barrel: the research family's import surface (new in P2-07).
export { aggregateAuthorityDistribution, scoreSource } from "./authority-score";
export { fetchLiveCandidates, researchAssessment } from "./assessment-producer";
export { assessItem, hasChanged, toAssessmentInput, toRow } from "./model/assess";
export { classifyTheme, THEME_VALUES, UNCLASSIFIED } from "./theme-rules";
export { researchWalker, walkResearch } from "./walker";
export type { WalkerDeps } from "./walker";
