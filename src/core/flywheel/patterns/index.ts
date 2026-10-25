// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the public surface of the pattern engine: the detectors, the step the connect stage calls, and the fact adapter.
export { PATTERNS } from "./config";
export { DETECTORS } from "./detect";
export { factOf, gradeOf } from "./facts";
export { loadPatternInput } from "./load";
export { patternMethod } from "./method";
export { runPatterns } from "./run";
export { KINDS } from "./types";
export type { Evidence, Fact, Pattern, PatternInput, PatternKind } from "./types";
