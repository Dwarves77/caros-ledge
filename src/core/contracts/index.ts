export { DERIVATION, DERIVATIONS, formatDelta, isContractable, isStatutory, makeEnvelope, propagateEnvelope, roundToSampleSupport, significantFigures, stalenessOf } from "./envelope";
export type { AsOf, Envelope, EnvelopeInput, Propagated } from "./envelope";
export { FACTOR_TIERS, isPrimaryData, primaryDataShare, renderEnvelopeColumnsSql, renderFactorCandidateViewSql, renderTierConstraintsSql, resolveActiveFactor, TIER_CODES, validateFactor } from "./factor-tier";
export type { Factor, Skipped } from "./factor-tier";
export { attributionsFor, licenceGate, licenceTriage, mayEmbedAsSeed, renderDataSourceSeedSql, SOURCE_KEYS, SOURCE_LICENCES } from "./source-licence";
export type { SourceLicence } from "./source-licence";
export { assertVerbatim, groundCandidate, isVerbatim } from "./verbatim";
export { admissibleInCalculation, citableAsFact, isMissing, isValid, LEG_MODE_CODES, MODE_CODES, normaliseMode, orderedValues, validatePedigree, VOCABULARIES, weakestOriginClass } from "./vocabularies";
export type { VocabEntry } from "./vocabularies";
