import { notFound } from "next/navigation";

import { WorkspaceFixtures } from "./WorkspaceFixtures";

// The UX smoke mounts the workspace screens here, one per `?screen=` (tests/ux/ux-smoke.mjs), against mocked backend responses. A 404 unless the env flag
// is set, which only the CI parity job and the local smoke run do; under /privacy so the proxy treats it as a public path.
export const dynamic = "force-dynamic";

export default async function WorkspaceFixturesPage({ searchParams }: { searchParams: Promise<{ screen?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  return <WorkspaceFixtures screen={(await searchParams).screen ?? "account"} />;
}
