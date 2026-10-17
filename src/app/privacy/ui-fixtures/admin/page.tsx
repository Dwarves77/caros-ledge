import { notFound } from "next/navigation";

import { AdminParts } from "@/features/admin/ui/parts/AdminParts";

// The UX smoke mounts the admin screens here, one per `?screen=` (tests/ux/admin-smoke.mjs), against mocked backend responses. A 404 unless the env flag
// is set, which only the CI parity job and the local smoke run do; under /privacy so the proxy treats it as a public path. The real screens sit behind the admin guard.
export const dynamic = "force-dynamic";

export default async function AdminFixturesPage({ searchParams }: { searchParams: Promise<{ screen?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  return <AdminParts screen={(await searchParams).screen ?? "console"} />;
}
