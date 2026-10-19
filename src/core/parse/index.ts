// The parse module's public surface: typed figures, the one comparator, identifiers and URLs. Rule tables are data under ./data.
export { containsNumeral, figuresEqual, numbersSumExactly, stateFigure } from "./compare";
export { findFigures, isFigure, isRefusal, parseFigure } from "./figure";
export type { Figure } from "./figure";
export { canonicalizeUrl, findIdentifiers, indexOfInsensitive, mentionsIdentifier, ownIdentifiers, sameIdentifier } from "./identifiers";
export type { Identifier } from "./identifiers";
export { resolveLocale } from "./locale";
export type { LocaleVerdict } from "./locale";
export { isTrajectoryUnit, kindOf } from "./unit";
export { contentWords, hasWord } from "./words";
