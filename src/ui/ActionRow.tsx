// Ported from old_repo/src/components/ui/ActionRow.tsx (lines 35-168)
import type { ReactNode } from "react";

import { Button } from "./Button";

interface ActionRowProps {
  onExport: () => void;
  onShare: () => void;
  watch: ReactNode;
  onTag?: (() => void) | undefined;
  exportDisabled?: boolean | undefined;
  overflow?: ReactNode;
  /** A viewer-role caller passes true: the + Tag action is not offered (the feature reads the role, the kit never reads a store). */
  viewer?: boolean;
}

/** Export brief, Share, Watch, + Tag: always visible, never in an overflow menu (ruling R5); the per-item overflow is the last control. A 2x2 grid on the phone. */
export function ActionRow({ onExport, onShare, watch, onTag, exportDisabled, overflow, viewer = false }: ActionRowProps) {
  return (
    <div className="cl-action-row">
      <Button variant="primary" onClick={onExport} disabled={exportDisabled}>
        Export brief
      </Button>
      <Button onClick={onShare}>Share</Button>
      {watch}
      {onTag && !viewer && (
        <Button dashed onClick={onTag}>
          + Tag
        </Button>
      )}
      {overflow}
    </div>
  );
}
