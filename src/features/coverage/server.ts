// The coverage feature's SERVER surface (IMP-106): what a page, a route or a loader outside the feature imports to read coverage. It reaches the service client and the admin guard, so a client component never imports it;
// the client-safe surface (the denominator line and the coverage page) is the feature's index. No other path into the feature is allowed from outside (eslint no-restricted-imports).
export { GET as coverageEntriesGET } from "./api/entries";
export { default as CoverageRoute } from "./page";
export { loadSurfaceDenominator, makeCoverageData } from "./server/matrix-data";
