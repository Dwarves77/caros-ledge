// Ported from old_repo/src/components/ui/ActionRow.tsx (lines 35-168)
import type { ReactNode } from "react";

interface ActionButtonProps {
  children: ReactNode;
  variant?: "primary" | "secondary" | "dashed";
  onClick?: () => void;
  disabled?: boolean;
  ariaPressed?: boolean;
  title?: string;
  onFocus?: () => void;
  onBlur?: () => void;
}

/** The detail action button chrome (44 px floor); hover is a base.css rule, not DOM mutation. */
export const ActionButton = ({ children, variant = "secondary", onClick, disabled, ariaPressed, title, onFocus, onBlur }: ActionButtonProps) => (
  <button type="button" onClick={onClick} disabled={disabled} aria-pressed={ariaPressed} title={title} onFocus={onFocus} onBlur={onBlur} className={`cl-action-btn cl-action-btn--${variant}`}>
    {children}
  </button>
);

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
      <ActionButton variant="primary" onClick={onExport} {...(exportDisabled !== undefined ? { disabled: exportDisabled } : {})}>
        Export brief
      </ActionButton>
      <ActionButton onClick={onShare}>Share</ActionButton>
      {watch}
      {onTag && !viewer && (
        <ActionButton variant="dashed" onClick={onTag}>
          + Tag
        </ActionButton>
      )}
      {overflow}
    </div>
  );
}
