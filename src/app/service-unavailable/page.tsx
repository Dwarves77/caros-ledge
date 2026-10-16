"use client";

// New in P2-09 (IMP-015): the route-neutral 503 page the proxy rewrites to when the auth service is unreachable on a protected route.
import { ErrorState } from "@/ui/Banners";

export default function ServiceUnavailable() {
  return (
    <div className="cl-page-pad">
      <ErrorState title="The sign-in service is unavailable" message="We could not check your sign-in just now. Your account is unchanged. Try again in a moment." onRetry={() => window.location.reload()} />
    </div>
  );
}
