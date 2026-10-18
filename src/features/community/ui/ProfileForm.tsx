"use client";

// Ported from old_repo/src/components/community/ProfileForm.tsx (lines 21-347)
// Your Community identity: organisation type, role, sector (chosen from the sector list, not typed), region, and whether your name and company are withheld by default; and verification by a company email address on your
// account (the verified mark stays even when your name is withheld). A failed load says so with Retry; a refusal shows its sentence. LinkedIn is a second verification method the profile admits and is not offered until it is scheduled.
import { useCallback, useEffect, useState } from "react";

import { ALL_SECTORS } from "@/core/workspace/vocabulary";
import { formatDate } from "@/core/shared";
import { Button, FormCard, FormField, Input, Select, StateNote, Switch } from "@/ui";

import { communityApi } from "../lib/api";
import { ORG_TYPE_OPTIONS, REGION_CODES, regionLabel } from "../lib/labels";
import type { OwnProfile } from "../lib/types";

import styles from "./community.module.css";
import { VerifiedMark } from "./parts/AuthorIdentity";

export function ProfileForm() {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [orgType, setOrgType] = useState("");
  const [role, setRole] = useState("");
  const [sector, setSector] = useState("");
  const [region, setRegion] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [save, setSave] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const [verify, setVerify] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const apply = (p: OwnProfile) => {
    setProfile(p);
    setOrgType(p.orgType ?? "");
    setRole(p.role ?? "");
    setSector(p.sector ?? "");
    setRegion(p.region ?? "");
    setAnonymous(p.defaultAnonymous);
  };
  const fetchProfile = useCallback(async () => {
    const r = await communityApi.profile();
    if (!r.ok || !r.data) return setLoad("failed");
    apply(r.data.profile);
    setLoad("ready");
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void fetchProfile();
  }, [fetchProfile]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSave({ busy: true, error: null, saved: false });
    const r = await communityApi.saveProfile({ org_type: orgType, role: role.trim() || null, sector: sector || null, region: region || null, default_anonymous: anonymous });
    if (!r.ok || !r.data) return setSave({ busy: false, error: r.error ?? "Your profile could not be saved.", saved: false });
    apply(r.data.profile);
    setSave({ busy: false, error: null, saved: true });
  }
  async function verifyNow() {
    setVerify({ busy: true, error: null });
    const r = await communityApi.verify();
    if (!r.ok || !r.data) return setVerify({ busy: false, error: r.error ?? "Verification did not complete." });
    apply(r.data.profile);
    setVerify({ busy: false, error: null });
  }

  if (load === "loading") return <p className={styles.muted}>Loading your profile…</p>;
  if (load === "failed")
    return (
      <StateNote tone="error" action={{ label: "Retry", onClick: () => { setLoad("loading"); void fetchProfile(); } }}>
        Your community profile could not be loaded. Nothing has changed.
      </StateNote>
    );
  return (
    <div className={styles.stack}>
      <form onSubmit={submit}>
        <FormCard title="Who you are in Community" foot={{ left: save.saved ? "Saved" : "Shown on your posts and replies", right: <Button type="submit" variant="primary" disabled={!orgType || save.busy}>{save.busy ? "Saving…" : "Save profile"}</Button> }}>
          <FormField label="Organisation type" required>
            {(c) => (
              <Select {...c} value={orgType} onChange={(e) => setOrgType(e.target.value)}>
                <option value="">Choose one</option>
                {ORG_TYPE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Role">{(c) => <Input {...c} value={role} maxLength={120} onChange={(e) => setRole(e.target.value)} placeholder="e.g. Trade lane manager" />}</FormField>
          <FormField label="Sector">
            {(c) => (
              <Select {...c} value={sector} onChange={(e) => setSector(e.target.value)}>
                <option value="">Not stated</option>
                {ALL_SECTORS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="Region">
            {(c) => (
              <Select {...c} value={region} onChange={(e) => setRegion(e.target.value)}>
                <option value="">Not stated</option>
                {REGION_CODES.map((code) => (
                  <option key={code} value={code}>
                    {regionLabel(code)}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <div className={styles.switchRow}>
            <Switch on={anonymous} onChange={setAnonymous} label="Withhold my name and company by default" busy={save.busy} />
            <span>Withhold my name and company on new posts by default. The verified-member mark still shows, and you can change it on each post.</span>
          </div>
          {save.error && <p role="alert" className={styles.error}>{save.error}</p>}
        </FormCard>
      </form>
      <FormCard title="Verification">
        {profile?.verified ? (
          <p>
            <VerifiedMark /> Verified by company email{profile.verifiedAt ? ` on ${formatDate(profile.verifiedAt)}` : ""}.
          </p>
        ) : (
          <>
            <p className={styles.muted}>A company email address on your account verifies you. Your organisation is never shown, only the verified mark; personal mail addresses cannot verify.</p>
            <Button variant="primary" disabled={verify.busy} onClick={() => void verifyNow()}>
              {verify.busy ? "Verifying…" : "Verify with my company email"}
            </Button>
            {verify.error && <p role="alert" className={styles.error}>{verify.error}</p>}
          </>
        )}
      </FormCard>
    </div>
  );
}
