// The parse module's public surface: typed figures, the one comparator, identifiers, hosts and URLs. Rule tables are data under ./data.
export { boundarySumWithin, checkBoundaries, checkWorkedExample, compareFigures, containsNumeral, figuresEqual, numberAsPrinted, numbersSumExactly, reconcile, stateFigure, withinPublishedDigit } from "./compare";
export type { Comparison, ExampleVerdict, Observation, Reconciled, Verdict, WorkedExample } from "./compare";
export { displayFigure, displayValue, figureOf, findFigures, isFigure, isRefusal, parseFigure, parsePhaseIn, storedValue } from "./figure";
export type { Figure, Hit, Missing, ParseOptions, Parsed, PhaseIn, Refusal } from "./figure";
export { canonicalizeUrl, findIdentifiers, findYearRanges, hostMatches, indexOfInsensitive, mentionsIdentifier, ownIdentifiers, parseCnCode, registrableDomain, sameIdentifier } from "./identifiers";
export type { Identifier, YearRange } from "./identifiers";
export { resolveLocale } from "./locale";
export type { LocaleVerdict } from "./locale";
export { convertValue, convertViaBridge, isTrajectoryUnit, kindOf } from "./unit";
export type { UnitParts } from "./unit";
export { contentWords, hasWord } from "./words";
