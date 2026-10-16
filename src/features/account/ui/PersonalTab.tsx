"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 461-524)
import { useState, type FormEvent } from "react";

import { Button, FormCard, FormField, InlineErrorBanner, Input, Textarea, Toast } from "@/ui";

import type { ProfilePatch } from "../lib/profile-patch";
import type { ProfileRow } from "../lib/use-account";

import styles from "./account.module.css";

/** The personal profile form: name, headshot URL, work email (read-only, the sign-in address) and bio. Saving says so, or says why not. */
export function PersonalTab({ profile, email, onSave }: { profile: ProfileRow; email: string; onSave: (patch: ProfilePatch) => Promise<string | null> }) {
  const [fullName, setFullName] = useState(profile.full_name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(profile.avatar_url ?? "");
  const [bio, setBio] = useState(profile.bio ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const message = await onSave({ full_name: fullName.trim() || null, avatar_url: avatarUrl.trim() || null, bio: bio.trim() || null });
    setSaving(false);
    if (message) setError(message);
    else setSaved(true);
  }

  return (
    <FormCard title="Personal profile" aside="Visible to your workspace">
      <form onSubmit={submit} className="cl-form-body" style={{ padding: 0 }}>
        <div className={styles.pair}>
          <FormField label="Full name">{(c) => <Input {...c} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" autoComplete="name" />}</FormField>
          <FormField label="Headshot URL">{(c) => <Input {...c} type="url" value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />}</FormField>
        </div>
        <FormField label="Work email" hint="The address you sign in with.">{(c) => <Input {...c} value={email} readOnly disabled />}</FormField>
        <FormField label="Bio">{(c) => <Textarea {...c} value={bio} onChange={(e) => setBio(e.target.value)} placeholder="A short bio for the community" />}</FormField>
        {error ? <InlineErrorBanner message={`Your profile was not saved: ${error}`} /> : null}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving..." : "Save personal profile"}
          </Button>
        </div>
      </form>
      <Toast message="Profile saved." visible={saved} onDismiss={() => setSaved(false)} />
    </FormCard>
  );
}
