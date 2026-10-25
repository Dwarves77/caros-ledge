// New in CONNECT-2 PR A (scripts/ci/new-files/connect-2a.txt): the public surface of the coupling vocabulary: the seeds pass, the ref mining and the resolver.
export { COLUMNS, COUPLING_RELATIONS, COUPLING_VERSION, COUPLINGS, couplingById, couplingByKey, couplingsForScenario, RELATIONS, roleOf, WINDOWS } from "./coupling";
export type { Coupling, Relation } from "./coupling";
export { mineRefs, tagRefs, uuidOf, writeRefs } from "./refs";
export type { RefRow } from "./refs";
export { buildResolver, resolveText } from "./resolve";
export { seedCouplings, seedPages } from "./seed";
