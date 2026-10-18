import { notFound } from "next/navigation";

import { CommunityFixtures } from "@/features/community/ui/fixtures/CommunityFixtures";

// The UX smoke mounts the Community screens here, one per `?screen=` (rooms, group, browse, directory, discover, moderation, profile), from fixed data, `&state=failed` with every read failed (tests/ux/community-smoke.mjs).
// A 404 unless the env flag is set (the CI parity job and the local smoke run only); under /privacy so the proxy treats it as a public path. It is the one file outside the Community directories that imports Community
// code (PROP-044's lint names it): a test mount, which feeds nothing.
export const dynamic = "force-dynamic";

export default async function CommunityFixturesPage({ searchParams }: { searchParams: Promise<{ screen?: string; state?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  const { screen = "rooms", state = "ok" } = await searchParams;
  return <CommunityFixtures screen={screen} state={state} />;
}
