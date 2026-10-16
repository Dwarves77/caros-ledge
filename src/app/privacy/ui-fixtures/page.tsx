import { notFound } from "next/navigation";

import { Fixtures } from "./Fixtures";

// The UX smoke mounts every row and card part here (tests/ux/ux-smoke.spec.ts). It lives under /privacy so the proxy treats it as a public path, and it is
// never reachable in production: without the env flag, set only in the CI parity job and the local smoke run, it is a 404.
export const dynamic = "force-dynamic";

export default function UiFixturesPage() {
  if (process.env.UI_FIXTURES !== "1") notFound();
  return <Fixtures />;
}
