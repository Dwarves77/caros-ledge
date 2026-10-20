"use client";

// Ported from old_repo/src/components/profile/OrganizationPanel.tsx (lines 42-293)
import { useState, type FormEvent } from "react";

import { requestJson } from "@/core/http/request-json";
import { formatLocaleDate } from "@/core/shared";
import { Button, FormCard, FormField, InlineErrorBanner, Input, RowTable, StateNote, Toast } from "@/ui";

import type { OrgPayload } from "../lib/use-account";

import styles from "./account.module.css";

const COLUMNS = [
  { label: "Name", width: "1fr" },
  { label: "Slug", width: "120px" },
  { label: "Plan", width: "110px" },
  { label: "Members", width: "160px" },
  { label: "Created", width: "120px" },
];

/**
 * The organisation: name and slug (the owner edits them) and the workspace record below as a disclosure (ruling R7). The data arrives from the account's one
 * loader, so the two tabs that mount this part read the organisation once. A failed read says so with Retry; a refused save keeps the typed values.
 */
export function OrganizationPanel({ orgId, org, error, onReload }: { orgId: string | null; org: OrgPayload | null; error: string | undefined; onReload: () => void }) {
  const [name, setName] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!orgId) return <FormCard title="Organization"><p className={styles.muted}>You are not yet a member of any workspace. Create one from onboarding, or accept an invitation, to fill in this tab.</p></FormCard>;
  if (!org) {
    return (
      <FormCard title="Organization" aside={error ? "Not loaded" : "Loading..."}>
        {error ? <StateNote tone="error" action={{ label: "Retry", onClick: onReload }}>The organisation did not load: {error}</StateNote> : <p className={styles.muted}>Loading organisation...</p>}
      </FormCard>
    );
  }

  const isOwner = (org.actions ?? []).includes("rename_org");
  const nameValue = name ?? org.org.name;
  const slugValue = slug ?? org.org.slug;
  const unchanged = nameValue.trim() === org.org.name && slugValue.trim().toLowerCase() === org.org.slug;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!org || !isOwner || unchanged) return;
    setSaving(true);
    setProblem(null);
    const body: { name?: string; slug?: string } = {};
    if (nameValue.trim() !== org.org.name) body.name = nameValue.trim();
    if (slugValue.trim().toLowerCase() !== org.org.slug) body.slug = slugValue.trim().toLowerCase();
    const r = await requestJson(`/api/orgs/${org.org.id}`, { method: "PATCH", body });
    setSaving(false);
    if (!r.ok) return setProblem(r.error);
    setName(null);
    setSlug(null);
    setSaved(true);
    onReload();
  }

  const created = new Date(org.org.created_at);
  return (
    <FormCard title="Organization" aside="Workspace-scoped settings persist to this org">
      <form onSubmit={submit} className={styles.orgRow}>
        <FormField label="Organization name">{(c) => <Input {...c} value={nameValue} onChange={(e) => setName(e.target.value)} disabled={saving || !isOwner} placeholder="Your organization name" />}</FormField>
        <FormField label="Slug">{(c) => <Input {...c} value={slugValue} onChange={(e) => setSlug(e.target.value.toLowerCase())} disabled={saving || !isOwner} placeholder="org-slug" />}</FormField>
        <Button type="submit" variant="primary" disabled={!isOwner || saving || unchanged}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </form>
      {!isOwner ? <p className={styles.muted}>Only the owner can rename the organisation.</p> : null}
      {problem ? <InlineErrorBanner message={`Not saved: ${problem}`} /> : null}
      <details className={styles.disclosure}>
        <summary>Workspace record</summary>
        <RowTable
          columns={COLUMNS}
          rows={[
            {
              key: org.org.id,
              cells: [
                <b key="n">{org.org.name}</b>,
                <span key="s" className={styles.mono}>{org.org.slug}</span>,
                <span key="p">{org.org.plan}</span>,
                <span key="m">
                  {org.member_count}
                  {org.owner ? ` · owner ${org.owner.display_name}` : ""}
                </span>,
                <span key="c">{Number.isNaN(created.getTime()) ? "—" : formatLocaleDate(created, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</span>,
              ],
            },
          ]}
        />
      </details>
      <Toast message="Organization updated." visible={saved} onDismiss={() => setSaved(false)} />
    </FormCard>
  );
}
