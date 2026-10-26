// The parse module's public surface: typed figures, the one comparator, identifiers and URLs. Rule tables are data under ./data.
export { containsNumeral, figuresEqual, stateFigure } from "./compare";
export { figureReadings, findFigures, isFigure } from "./figure";
export type { Figure } from "./figure";
export { canonicalizeUrl, findIdentifiers, hostMatches, indexOfInsensitive, mentionsIdentifier, ownIdentifiers, renderCanonicalizeUrlSql, sameIdentifier, TRACKING_PARAMS } from "./identifiers";
export type { Identifier } from "./identifiers";
export { interpretNumber, resolveLocale, scanNumbers } from "./locale";
export type { LocaleVerdict } from "./locale";
export { isTrajectoryUnit, kindOf, statutoryUnit } from "./unit";
export type { UnitForm } from "./unit";
export { contentWords, hasWord } from "./words";
