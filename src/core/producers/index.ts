// Barrel: the producer runner's import surface (new in P2-07).
export type { FetchFn, ProducerDeps, Recorder } from "./deps";
export { loadProducerRegistry, runRegistered, selectRuns } from "./registry";
export type { Catalog, RegistryEntry } from "./registry";
export { loadRowsFile, parseOperatorRows, registerCitedSource, requireCitation, resolveEntityByName, RowsFileError, validateEntityRefs } from "./rows-file";
export { decideApply, licenceBlockOf, makeGetter, NetworkError, runProducer, StructureError } from "./runner";
export type { ProducerCtx, ProducerSpec, RunInput } from "./runner";
export { foldProducerSummaries, writeProducerSummary } from "./summary";
export { planKeyedUpsert } from "./upsert-plan";
export { readSheet } from "./xlsx";
