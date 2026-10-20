// The escalation ladder with every rung a member: a test names the rungs it runs and the rest are null, as the production caller states them.
import type { LadderDeps } from "@/core/fetch/ladder";

export const rungs = (over: Partial<LadderDeps> = {}): LadderDeps => ({ licence: () => null, cacheGet: null, apiFetch: null, feedFetch: null, sitemapProbe: null, directFetch: null, browserFetch: null, substituteFetch: null, contactOf: null, seekMore: null, max: 0, source: null, skip: [], ...over });
