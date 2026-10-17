// Ported from old_repo/src/components/ui/ListRow.tsx (lines 139-142, 225-260, 556-668)
// The jurisdiction register row and its header (map only): the whole row is one link into the Regulations list filtered to the jurisdiction; code, name, the active themes, the most urgent band and the
// item count. 44 px at least. The code shown is the jurisdiction's own (never one cut from its name).
import Link from "next/link";

import type { UrgencyBand } from "@/core/lists";

export function RegisterHeader() {
  return (
    <div className="cl-detail-label cl-jreg cl-jreg-head" data-part="register-header">
      <span aria-hidden="true" />
      <span>Jurisdiction</span>
      <span>Active themes</span>
      <span>Band</span>
      <span className="cl-jreg-count">Items</span>
    </div>
  );
}

export function RegisterRow({ href, band, code, label, themes, count }: { href: string; band: UrgencyBand; code: string; label: string; themes: string; count: number }) {
  return (
    <div className="cl-jreg cl-jreg-row" data-part="register-row">
      <Link href={href} prefetch={false} aria-label={label} className="cl-jreg-link" />
      <span aria-hidden="true" className="cl-jreg-bar" style={{ background: band.cssVar }} />
      <span className="cl-jreg-name">
        {code && <span className="cl-detail-label cl-jreg-code">{code}</span>}
        <span data-guard-title className="cl-jreg-label">
          {label}
        </span>
      </span>
      <span className="cl-jreg-themes">{themes || "—"}</span>
      <span className="cl-jreg-band" style={{ color: band.cssVar }}>{band.label}</span>
      <span className="cl-jreg-count cl-jreg-num">{count.toLocaleString("en-US")}</span>
    </div>
  );
}
