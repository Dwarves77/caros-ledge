import { notFound } from "next/navigation";

import { DashSearchFixtures } from "./DashSearchFixtures";

// The UX smoke mounts the dashboard, watchlist, search, portfolio and Assistant screens here, one per `?screen=` (tests/ux/dash-search-smoke.mjs), against mocked backend responses. `?titles=` is a JSON list of
// result titles the fixture parity run feeds the search screen from the parity baseline. A 404 unless the env flag is set, which only the CI parity job and the local smoke run do; under /privacy so the proxy treats it as a public path.
export const dynamic = "force-dynamic";

export default async function DashSearchFixturesPage({ searchParams }: { searchParams: Promise<{ screen?: string; titles?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  const { screen, titles } = await searchParams;
  let list: string[] = [];
  try {
    const parsed: unknown = titles ? JSON.parse(titles) : [];
    list = Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    list = [];
  }
  return <DashSearchFixtures screen={screen ?? "dashboard"} titles={list} />;
}
