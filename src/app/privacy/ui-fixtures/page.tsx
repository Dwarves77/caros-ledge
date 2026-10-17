import { notFound } from "next/navigation";

import { PartsGallery } from "@/features/admin/ui/parts/PartsGallery";

// The UX smoke mounts every row and card part here (tests/ux/ux-smoke.mjs). It is the same gallery the platform admin opens at /admin/parts; this mount lives under /privacy so the proxy
// treats it as a public path for the unauthenticated smoke, and it is never reachable in production: without the env flag, set only in the CI parity job and the local smoke run, it is a 404.
export const dynamic = "force-dynamic";

export default function UiFixturesPage() {
  if (process.env.UI_FIXTURES !== "1") notFound();
  return <PartsGallery />;
}
