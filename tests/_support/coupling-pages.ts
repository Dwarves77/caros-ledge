// The pages couplings.json cites, as the fixture transport serves them: each URL answers a body that holds every quote taken from it verbatim (and the notice around it a capture needs to reach 1,000 characters), so the seeds pass of the propagate stage
// captures, rates and grounds the whole vocabulary in a fixture turn exactly as it does against the live pages.
import { COUPLING_RELATIONS, COUPLINGS } from "@/core/coupling";

const FILLER = "Notice. This page is provided for information and is reproduced here as the fixture transport serves it. ".repeat(12);

export function couplingRoutes(): Record<string, () => Response> {
  const quotes = new Map<string, Set<string>>();
  for (const c of [...COUPLINGS.map((x) => x.citation), ...COUPLING_RELATIONS.flatMap((r) => r.citations)]) if (c) quotes.set(c.url, (quotes.get(c.url) ?? new Set()).add(c.quote));
  return Object.fromEntries([...quotes].map(([url, qs]) => [url, () => new Response(`${[...qs].join("\n")}\n${FILLER}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } })]));
}
