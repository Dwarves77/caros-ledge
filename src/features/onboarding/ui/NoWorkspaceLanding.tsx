"use client";

// Ported from old_repo/src/components/onboarding/NoWorkspaceLanding.tsx (lines 54-389)
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";

import { browserClient } from "@/core/db/browser";
import { requestJson } from "@/core/http/request-json";
import { formatLocaleDate } from "@/core/shared";
import { ORG_SIZE_DIMENSIONS } from "@/core/workspace/org-profile";
import { ALL_SECTORS, REGIONS } from "@/core/workspace/vocabulary";
import { saveProfilePatch } from "@/features/account/lib/profile-patch";
import { AuthFrame } from "@/features/auth/ui/AuthFrame";
import { Button, ChoiceChip, EmptyState, FormField, InlineErrorBanner, Input, Select, StateNote } from "@/ui";

import { tokenFrom } from "../lib/token";

import { OnboardingStepper } from "./OnboardingStepper";
import styles from "./onboarding.module.css";

interface PendingInvitation {
  id: string;
  org_name: string | null;
  org_slug: string | null;
  proposed_role: string;
  expires_at: string;
}
type Invitations = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; list: PendingInvitation[] };

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
function Panel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={styles.panel}>
      <h2 id={id} className={styles.panelTitle}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Step 1 of onboarding: a signed-in reader with no workspace. Pending invitations come first (accept joins with the role the inviter granted; in-app
 * Accept and Decline act on the invitation row, migration 0028), then a pasted link, then creating an organisation (the creator becomes its owner).
 * There is deliberately no way to pick an existing organisation by name: joining is by invitation only. Every request is made in a try with a pending
 * state, and a failed invitation read says so with Retry instead of reading as "no invitations".
 */
export function NoWorkspaceLanding({ userId, userEmail }: { userId: string; userEmail: string }) {
  const [invitations, setInvitations] = useState<Invitations>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [jobTitle, setJobTitle] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  const [orgName, setOrgName] = useState("");
  const [sectors, setSectors] = useState<string[]>([]);
  const [headcount, setHeadcount] = useState("");
  const [regions, setRegions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void requestJson<{ invitations?: PendingInvitation[] }>("/api/invitations/mine").then((r) => {
      if (!cancelled) setInvitations(r.ok ? { phase: "ready", list: r.data?.invitations ?? [] } : { phase: "error", message: r.error ?? "Invitations could not be loaded." });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Save the typed job title on the reader's own profile; false (with the reason shown) when it cannot be saved. */
  async function saveJobTitle(): Promise<boolean> {
    const title = jobTitle.trim();
    if (!title) return true;
    const message = await saveProfilePatch(browserClient(), userId, { job_title: title });
    if (message) setError(`Your job title could not be saved (${message}). Fix it or clear it to continue without one.`);
    return !message;
  }

  /** Accept by row id (the list) or by pasted token, then a hard reload so the new membership is resolved everywhere. */
  async function accept(key: string, path: string) {
    setError(null);
    setBusy(key);
    if (await saveJobTitle()) {
      const r = await requestJson(path, { method: "POST" });
      if (r.ok) return window.location.assign("/");
      setError(r.error);
    }
    setBusy(null);
  }

  async function decline(inv: PendingInvitation) {
    setError(null);
    setBusy(inv.id);
    const r = await requestJson(`/api/invitations/mine/${inv.id}/decline`, { method: "POST" });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setInvitations((s) => (s.phase === "ready" ? { phase: "ready", list: s.list.filter((i) => i.id !== inv.id) } : s));
  }

  function submitPaste(e: FormEvent) {
    e.preventDefault();
    const token = tokenFrom(paste);
    if (!token) return setError("That does not look like an invitation link or token. Paste the whole link from the email.");
    void accept("paste", `/api/invitations/${token}/accept`);
  }

  async function createOrg(e: FormEvent) {
    e.preventDefault();
    if (!orgName.trim()) return;
    setError(null);
    setBusy("create");
    const r = await requestJson("/api/orgs", { method: "POST", body: { name: orgName.trim(), sectors, regions, ...(headcount ? { headcount_band: headcount } : {}), ...(jobTitle.trim() ? { job_title: jobTitle.trim() } : {}) } });
    if (r.ok) return window.location.assign("/onboarding");
    setBusy(null);
    setError(r.error ?? "Could not create your organisation. Check the details and try again.");
  }

  return (
    <AuthFrame>
      <div className={styles.column}>
        <OnboardingStepper current={1} />
        <h1 className={styles.title}>Set up your workspace</h1>
        <p className={styles.lead}>Signed in as {userEmail}. Accept an invitation from your team, or create your organisation. You become its owner and can invite teammates after.</p>
        {error ? <InlineErrorBanner message={error} /> : null}

        <Panel title="Your job title">
          <FormField label="Job title (optional)" hint="Saved on your profile whichever way you continue.">{(c) => <Input {...c} value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} placeholder="e.g. Head of operations" />}</FormField>
        </Panel>

        <Panel title="Pending invitations">
          {invitations.phase === "loading" ? <p className="cl-field-hint">Looking for invitations...</p> : null}
          {invitations.phase === "error" ? (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => (setInvitations({ phase: "loading" }), setAttempt((n) => n + 1)) }}>
              Invitations did not load: {invitations.message}
            </StateNote>
          ) : null}
          {invitations.phase === "ready" && invitations.list.length === 0 ? <EmptyState>No pending invitations for {userEmail}.</EmptyState> : null}
          {invitations.phase === "ready" && invitations.list.length > 0 ? (
            <ul className={styles.list}>
              {invitations.list.map((inv) => (
                <li key={inv.id} className={styles.invite}>
                  <div className={styles.inviteText}>
                    <p className={styles.inviteName}>{inv.org_name || inv.org_slug || "A workspace"}</p>
                    <p className={styles.inviteMeta}>
                      Role: {inv.proposed_role} · Expires {formatLocaleDate(new Date(inv.expires_at), { timeZone: "UTC" })}
                    </p>
                  </div>
                  <div className={styles.navRight}>
                    <Button variant="primary" disabled={busy !== null} onClick={() => void accept(inv.id, `/api/invitations/mine/${inv.id}/accept`)}>
                      {busy === inv.id ? "Working..." : "Accept"}
                    </Button>
                    <Button variant="secondary" disabled={busy !== null} onClick={() => void decline(inv)}>
                      Decline
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <Panel title="Have an invitation URL?">
          <form onSubmit={submitPaste} className={styles.row}>
            <FormField label="Invitation URL or token">{(c) => <Input {...c} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste your invitation URL or token here" />}</FormField>
            <Button type="submit" variant="primary" disabled={!paste.trim() || busy !== null}>
              {busy === "paste" ? "Accepting..." : "Accept"}
            </Button>
          </form>
        </Panel>

        <Panel title="Or create your organisation">
          <form onSubmit={createOrg} className={styles.column}>
            <FormField label="Organisation name" required>{(c) => <Input {...c} value={orgName} onChange={(e) => setOrgName(e.target.value)} maxLength={200} placeholder="Your company" />}</FormField>
            <FormField group label="Industry or sector (choose all that apply)">
              {() => (
                <div className={styles.grid2}>
                  {ALL_SECTORS.map((s) => (
                    <ChoiceChip key={s.id} label={s.label} pressed={sectors.includes(s.id)} onToggle={() => setSectors((p) => toggle(p, s.id))} />
                  ))}
                </div>
              )}
            </FormField>
            <FormField label="Company size">
              {(c) => (
                <Select {...c} value={headcount} onChange={(e) => setHeadcount(e.target.value)}>
                  <option value="">Prefer not to say</option>
                  {(ORG_SIZE_DIMENSIONS.headcount?.bands ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField group label="Region (choose all that apply)">
              {() => (
                <div className={styles.grid2}>
                  {REGIONS.map((r) => (
                    <ChoiceChip key={r.id} label={r.label} pressed={regions.includes(r.id)} onToggle={() => setRegions((p) => toggle(p, r.id))} />
                  ))}
                </div>
              )}
            </FormField>
            <Button type="submit" variant="primary" disabled={!orgName.trim() || busy !== null}>
              {busy === "create" ? "Creating your organisation..." : "Create organisation"}
            </Button>
            <p className="cl-field-hint">You become the owner. Sector, size and region tailor what you see, and you can change them later in Settings.</p>
          </form>
        </Panel>
      </div>
    </AuthFrame>
  );
}
