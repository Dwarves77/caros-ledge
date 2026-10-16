"use client";

// Ported from old_repo/src/components/settings/OrganisationProfileSection.tsx (lines 58-286)
import { useState } from "react";

import { ORG_ROLES, ORG_SIZE_DIMENSIONS, PROFILE_JSON_KEYS, parseOrgProfile, validateProfileInput, type OrgProfile } from "@/core/workspace";
import { useWorkspaceStore } from "@/core/workspace/store";
import { Button, ChoiceChip, FormCard, FormField, InlineErrorBanner, Toast } from "@/ui";

import { useSettingsStore } from "../state/settings-store";

import { SettingsGate } from "./SettingsGate";
import styles from "./settings.module.css";

const DIMENSIONS = ["headcount", "revenue", "shipment_volume"] as const;
const sameProfile = (a: OrgProfile, b: OrgProfile) =>
  a.orgRoles.length === b.orgRoles.length && a.orgRoles.every((r) => b.orgRoles.includes(r)) && DIMENSIONS.every((d) => a.orgSize[`${d}_band`] === b.orgSize[`${d}_band`]);

function ProfileForm() {
  const stored = useSettingsStore((s) => s.profile);
  const commit = useSettingsStore((s) => s.commit);
  const role = useWorkspaceStore((s) => s.userRole);
  const orgName = useWorkspaceStore((s) => s.orgName);
  const canEdit = role === "owner" || role === "admin";
  const baseline = parseOrgProfile(stored);
  const [draft, setDraft] = useState<OrgProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const profile = draft ?? baseline;
  const dirty = !sameProfile(profile, baseline);

  const toggleRole = (id: string) => canEdit && setDraft({ ...profile, orgRoles: profile.orgRoles.includes(id) ? profile.orgRoles.filter((r) => r !== id) : [...profile.orgRoles, id] });
  const setBand = (dimension: (typeof DIMENSIONS)[number], bandId: string | null) => canEdit && setDraft({ ...profile, orgSize: { ...profile.orgSize, [`${dimension}_band`]: bandId } });

  async function save() {
    const check = validateProfileInput(profile);
    if (!check.valid) return setError(check.errors.join("; "));
    setSaving(true);
    setError(null);
    // The profile column is patched key-wise (INV-168): this writer owns the org_roles and org_size keys and nothing else in the column.
    const message = await commit("profile", { [PROFILE_JSON_KEYS.orgRoles]: profile.orgRoles, [PROFILE_JSON_KEYS.orgSize]: profile.orgSize });
    setSaving(false);
    if (message) return setError(message);
    setDraft(null);
    setSaved(true);
  }

  return (
    <>
      <p className="cl-field-hint">Which roles you hold and your organisation&apos;s size, used to show whether a regulation applies to you.</p>
      <FormField group label="What does your organisation do? Select every role that applies">
        {() => (
          <div className={styles.chips}>
            {ORG_ROLES.map((r) => (
              <ChoiceChip key={r.id} label={r.label} pressed={profile.orgRoles.includes(r.id)} onToggle={() => toggleRole(r.id)} disabled={!canEdit} />
            ))}
          </div>
        )}
      </FormField>
      {DIMENSIONS.map((d) => {
        const dimension = ORG_SIZE_DIMENSIONS[d];
        if (!dimension) return null;
        const current = profile.orgSize[`${d}_band`];
        return (
          <FormField group key={d} label={dimension.label}>
            {() => (
              <div className={styles.chips}>
                {dimension.bands.map((b) => (
                  <ChoiceChip key={b.id} label={b.label} pressed={current === b.id} onToggle={() => setBand(d, current === b.id ? null : b.id)} disabled={!canEdit} />
                ))}
              </div>
            )}
          </FormField>
        );
      })}
      {!canEdit ? <p className="cl-field-hint">Only an owner or admin can change the organisation profile.</p> : null}
      {error ? <InlineErrorBanner message={`Not saved: ${error}`} /> : null}
      <div>
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || !canEdit || saving}>
          {saving ? "Saving..." : "Save organisation profile"}
        </Button>
      </div>
      <p className="cl-field-hint">A regulation that only applies to a role or size you have not set will show what information it still needs from you, rather than guessing.</p>
      <Toast message={`Saved to ${orgName || "workspace"}.`} visible={saved} onDismiss={() => setSaved(false)} />
    </>
  );
}

/** Roles and size bands, written to workspace_settings.profile through the store's one writer, read back by the relevance lens. Loads once with the page's other settings. */
export function OrganisationProfileSection() {
  return (
    <FormCard title="Organisation profile" aside="Role & size">
      <SettingsGate>
        <ProfileForm />
      </SettingsGate>
    </FormCard>
  );
}
