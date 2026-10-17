"use client";

// Ported from old_repo/src/components/workspace/ArchiveDialog.tsx (lines 29-423)
import { useEffect, useState, type FormEvent } from "react";

import { requestJson } from "@/core/http/request-json";
import { Button, Dialog, FormField, Select, StateNote, Textarea } from "@/ui";

import { useItemStateStore } from "../state";

import { ARCHIVE_REASONS } from "./archive-reasons";
import styles from "./workspace.module.css";

interface ArchiveImpact {
  title: string | null;
  isCritical: boolean;
  canArchiveWorkspace: boolean;
  watcherCount: number;
  watcherNames: string[];
  /** The item sits on the workspace watchlist (org_watchlist), surfaced to every member; distinct from watcherCount, which counts personal watches. */
  onTeamWatchlist: boolean;
  ownerName: string | null;
}

type Scope = "personal" | "workspace";

/** What a team archive will do, from the live impact read: nothing guessed, nothing shown that the server did not say. */
function impactLines(impact: ArchiveImpact): string[] {
  const lines: string[] = [];
  if (impact.isCritical) lines.push("This item is marked CRITICAL. Archiving removes it from everyone's active views.");
  if (impact.ownerName) lines.push(`Assigned to ${impact.ownerName}, who will be notified.`);
  if (impact.watcherCount > 0) {
    const shown = impact.watcherNames.length > 0 ? `: ${impact.watcherNames.join(", ")}${impact.watcherCount > impact.watcherNames.length ? ` and ${impact.watcherCount - impact.watcherNames.length} more` : ""}` : "";
    lines.push(`${impact.watcherCount === 1 ? "1 teammate is watching" : `${impact.watcherCount} teammates are watching`}${shown}. They will be notified.`);
  }
  if (impact.onTeamWatchlist) lines.push("This item is on the workspace watchlist, so every member sees it. Archiving removes it from their active views while it stays on the watchlist.");
  return lines;
}

/**
 * The dual-scope archive (migration 235). Archiving is never one unlabelled button: "Just me" is the default (the narrower scope is the safe accident),
 * "My whole team" asks for a reason, names who is told, and is refused by the server for a non-admin (INV-165). The role the impact read returns only
 * disables the option with its reason; the server's own message is what a refusal shows. Mount it to open it, unmount it to close it.
 */
export function ArchiveDialog({ itemId, title, onClose, onArchived }: { itemId: string; title: string; onClose: () => void; onArchived?: (scope: Scope) => void }) {
  const archiveResource = useItemStateStore((s) => s.archiveResource);
  const archivePersonal = useItemStateStore((s) => s.archivePersonal);
  const [scope, setScope] = useState<Scope>("personal");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [impact, setImpact] = useState<ArchiveImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void requestJson<ArchiveImpact>(`/api/workspace/archive-impact?itemId=${encodeURIComponent(itemId)}`).then((r) => {
      if (cancelled) return;
      setImpact(r.data);
      setImpactError(r.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [itemId, attempt]);

  // Advisory only: a false here disables the team option with a reason; the 403 from the write path is the gate.
  const canTeam = impact ? impact.canArchiveWorkspace : true;
  const teamSelected = scope === "workspace";
  const lines = teamSelected && impact ? impactLines(impact) : [];
  const close = () => !submitting && onClose();

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (submitting || (teamSelected && !reason)) return;
    setError(null);
    setSubmitting(true);
    const failure = teamSelected ? await archiveResource(itemId, reason, note.trim()) : await archivePersonal(itemId, note.trim());
    setSubmitting(false);
    if (failure) return setError(failure);
    onArchived?.(scope);
    onClose();
  }

  return (
    <Dialog open onClose={close} title="Archive this item">
      <form onSubmit={submit} className={styles.dialogForm}>
        <p className={styles.itemTitle}>{title}</p>
        <fieldset className={styles.scopes}>
          <legend className="cl-field-label">Who should this be archived for?</legend>
          <label className={styles.scope}>
            <input type="radio" name="archive-scope" checked={!teamSelected} onChange={() => setScope("personal")} disabled={submitting} />
            <span>
              <b>Just me</b>
              <span className={styles.scopeNote}>Hides it from your views only. Your teammates are not affected and are not notified. You can undo this at any time.</span>
            </span>
          </label>
          <label className={styles.scope}>
            <input type="radio" name="archive-scope" checked={teamSelected} onChange={() => setScope("workspace")} disabled={submitting || !canTeam} />
            <span>
              <b>My whole team</b>
              <span className={styles.scopeNote}>{canTeam ? "Hides it for everyone in your workspace. Watchers and the assigned owner are notified, and any member can restore it." : "Only an admin or owner can archive for the whole team. You can still archive it just for yourself."}</span>
            </span>
          </label>
        </fieldset>

        {teamSelected && loading ? <p className={styles.muted}>Checking who this affects...</p> : null}
        {teamSelected && impactError ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => (setLoading(true), setAttempt((n) => n + 1)) }}>
            Could not load who this affects. The team option stays available; the server re-checks permissions on save.
          </StateNote>
        ) : null}
        {lines.length > 0 ? (
          <div role="status" className={styles.impact}>
            <b>What this will do</b>
            {lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        ) : null}

        {teamSelected ? (
          <FormField label="Reason" required hint="Required for the team. Everyone who is notified sees this reason.">
            {(c) => (
              <Select {...c} value={reason} onChange={(e) => setReason(e.target.value)} disabled={submitting}>
                <option value="">Choose a reason</option>
                {ARCHIVE_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        ) : null}
        <FormField label="Note (optional)">
          {(c) => <Textarea {...c} rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={submitting} placeholder={teamSelected ? "Anything the team should know." : "Just for your own reference."} />}
        </FormField>

        {error ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => void submit() }}>
            {error}
          </StateNote>
        ) : null}
        <div className={styles.actions}>
          <Button variant="secondary" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || (teamSelected && !reason)}>
            {submitting ? "Archiving..." : teamSelected ? "Archive for the team" : "Archive for me"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
