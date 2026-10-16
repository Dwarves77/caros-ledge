"use client";

// Ported from old_repo/src/components/settings/ArchiveViewer.tsx (lines 27-224)
import Link from "next/link";
import { useMemo, useState } from "react";

import { formatDate } from "@/core/shared";
import { Button, EmptyState, FormField, Input, Select, Toast } from "@/ui";

import type { ArchiveRow } from "../archive-types";
import { useItemStateStore } from "../state";

import { reasonLabel } from "./archive-reasons";
import styles from "./workspace.module.css";

const keyOf = (row: ArchiveRow) => `${row.scope}:${row.itemId}`;

/**
 * The archive list, team and personal rows each labelled by who the archive hides the item from, because that is what Restore undoes: a single
 * unlabelled Restore would be wrong in one direction or the other. Both scopes surface a failed restore on the row (the old team restore was
 * fire-and-forget), and a row whose item cannot be named never shows a raw id.
 */
export function ArchiveViewer({ rows }: { rows: ArchiveRow[] }) {
  const restoreResource = useItemStateStore((s) => s.restoreResource);
  const restorePersonal = useItemStateStore((s) => s.restorePersonal);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const live = useMemo(() => rows.filter((r) => !gone.has(keyOf(r))), [rows, gone]);
  const reasons = useMemo(() => [...new Set(live.map((r) => r.reason).filter((r): r is string => !!r))], [live]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return live.filter((r) => (!reason || r.reason === reason) && (!q || `${r.title} ${r.note ?? ""} ${reasonLabel(r.reason) ?? ""}`.toLowerCase().includes(q)));
  }, [live, search, reason]);

  async function restore(row: ArchiveRow) {
    const key = keyOf(row);
    setFailure(null);
    setBusy(key);
    const message = row.scope === "personal" ? await restorePersonal(row.itemId) : await restoreResource(row.itemId);
    setBusy(null);
    if (message) return setFailure({ key, message });
    setGone((prev) => new Set(prev).add(key));
    setToast(`Restored ${row.title}`);
  }

  if (live.length === 0) return <EmptyState>Nothing archived. Items you archive collect here, out of the working view but never deleted.</EmptyState>;
  return (
    <div className={styles.archive}>
      <div className={styles.archiveFilters}>
        <FormField label="Search the archive">{(c) => <Input {...c} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Title, note or reason" />}</FormField>
        <FormField label="Reason">
          {(c) => (
            <Select {...c} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">All reasons</option>
              {reasons.map((r) => (
                <option key={r} value={r}>
                  {reasonLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      {shown.length === 0 ? (
        <EmptyState>No archived items match. Adjust the search or the reason.</EmptyState>
      ) : (
        <ul className={styles.archiveList}>
          {shown.map((row) => {
            const key = keyOf(row);
            const personal = row.scope === "personal";
            return (
              <li key={key} className={styles.archiveRow}>
                <div className={styles.archiveMain}>
                  <Link href={row.href} className={styles.archiveTitle}>
                    {row.title}
                  </Link>
                  <p className={styles.archiveMeta}>
                    <span title={personal ? "You archived this for yourself. Your teammates still see it." : "Archived for the whole workspace."}>{personal ? "Just you" : "Whole team"}</span>
                    {reasonLabel(row.reason) ? <span>{reasonLabel(row.reason)}</span> : null}
                    {row.archivedAt ? <span>{formatDate(row.archivedAt)}</span> : null}
                    {row.replacement ? (
                      <Link href={row.replacement.href} className={styles.inlineLink}>
                        Replacement: {row.replacement.title}
                      </Link>
                    ) : null}
                  </p>
                  {failure?.key === key ? (
                    <p role="alert" className={styles.rowError}>
                      {failure.message}
                    </p>
                  ) : null}
                </div>
                <Button variant="secondary" size="sm" disabled={busy !== null} aria-label={personal ? `Restore ${row.title} for yourself` : `Restore ${row.title} for the whole team`} onClick={() => void restore(row)}>
                  {busy === key ? "Restoring..." : "Restore"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <Toast message={toast ?? ""} visible={toast !== null} onDismiss={() => setToast(null)} />
    </div>
  );
}
