// Ported from old_repo/src/components/ui/ErrorState.tsx (lines 12-44)
// Ported from old_repo/src/components/ui/InlineErrorBanner.tsx (lines 14-33)
// Ported from old_repo/src/components/ui/SystemErrorBanner.tsx (lines 1-36)
import type { ReactNode } from "react";

import { Button } from "./Button";

/** Full-page error with retry. The default copy blames neither the database nor the user's connection (the old copy did). */
export function ErrorState({ title = "Something went wrong", message = "This didn't load. Try again; if it keeps happening, the reference below helps us find it.", onRetry, reference }: { title?: string; message?: string; onRetry?: () => void; reference?: string | undefined }) {
  return (
    <div className="cl-error-state" role="alert" data-part="page-failure">
      <div className="cl-error-state-mark" aria-hidden="true">
        !
      </div>
      <h3 className="cl-error-state-title">{title}</h3>
      <p className="cl-error-state-message">{message}</p>
      {reference && <p className="cl-error-state-ref">Reference: {reference}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export const InlineErrorBanner = ({ message, children }: { message: string; children?: ReactNode }) => (
  <div role="alert" data-part="state-note" className="cl-inline-error">
    {message}
    {children}
  </div>
);

