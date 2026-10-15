// Ported from old_repo/src/app/login/page.tsx (lines 37-37)
import { Suspense } from "react";

import LoginPage from "@/features/auth/ui/LoginPage";

export default function Page() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
