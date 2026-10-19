// Ported from old_repo/src/components/layout/PageFrame.tsx (lines 1-49)
import type { ReactNode } from "react";

/** The one page frame: the content column plus an optional 300 px rail (a frame with no rail is one column: it never reserves the empty rail track); the rail folds under the content at 1279 px and the phone pads 14/16/16 (base.css). */
export function PageFrame({ children, rail, padding = "default", className }: { children: ReactNode; rail?: ReactNode; padding?: "default" | "account"; className?: string }) {
  return (
    <div data-guard-frame className={`cl-page-frame cl-page-frame--${padding}${rail ? "" : " cl-page-frame--solo"}${className ? ` ${className}` : ""}`}>
      {children}
      {rail}
    </div>
  );
}
