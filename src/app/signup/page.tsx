// Ported from old_repo/src/app/signup/page.tsx (lines 43-43)
import { Suspense } from "react";

import SignupPage from "@/features/auth/ui/SignupPage";

export default function Page() {
  return (
    <Suspense>
      <SignupPage />
    </Suspense>
  );
}
