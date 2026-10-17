import { notFound } from "next/navigation";
import { Suspense } from "react";

import { SurfaceFixtures } from "./SurfaceFixtures";

// New in P2-12: the UX smoke mounts the Research and Operations screens here, one per `?screen=` (tests/ux/ux-smoke.mjs). A 404 unless the env flag is set, which only the CI parity job and the local smoke run do;
// under /privacy so the proxy treats it as a public path. The lists read the URL (useSearchParams), so they sit inside a Suspense boundary.
export const dynamic = "force-dynamic";

export default async function SurfaceFixturesPage({ searchParams }: { searchParams: Promise<{ screen?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  return (
    <Suspense fallback={null}>
      <SurfaceFixtures screen={(await searchParams).screen ?? "parts"} />
    </Suspense>
  );
}
