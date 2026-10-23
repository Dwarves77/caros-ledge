"use client";

// Ported from old_repo/src/components/onboarding/OnboardingWizard.tsx (lines 82-304)
// Ported from old_repo/src/components/onboarding/OnboardingWizard.tsx (lines 308-422)
// Ported from old_repo/src/components/onboarding/OnboardingWizard.tsx (lines 464-516)
// Ported from old_repo/src/components/onboarding/OnboardingWizard.tsx (lines 582-633)
import Link from "next/link";
import { useEffect, useState } from "react";

import { readFailure } from "@/core/http/failure";
import { browserClient } from "@/core/db/browser";
import { BAND_ORDER } from "@/core/lists";
import { patchWorkspaceSettings } from "@/core/workspace/settings";
import { ALL_SECTORS, HIGHLIGHTED_SECTOR_IDS, JURISDICTIONS, MODES } from "@/core/workspace/vocabulary";
import { useWorkspaceStore } from "@/core/workspace/store";
import { DEFAULT_NOTIFICATION_PREFS, saveNotificationPrefs } from "@/features/account/lib/notification-prefs";
import { saveProfilePatch } from "@/features/account/lib/profile-patch";
import { AuthFrame, AuthMasthead } from "@/features/auth/ui/AuthFrame";
import { BriefingScheduleSection } from "@/features/settings/ui/BriefingScheduleSection";
import { useSettingsStore } from "@/features/settings/state/settings-store";
import { BandTile, BandTileRow, Button, ChoiceChip, InlineErrorBanner, StateNote } from "@/ui";

import { OnboardingStepper } from "./OnboardingStepper";
import styles from "./onboarding.module.css";

type Step = 2 | 3 | 4 | 5;
const FIRST_JURISDICTIONS = 6;
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

function Heading({ children }: { children: string }) {
  return <h3 className={styles.eyebrow}>{children}</h3>;
}

/**
 * Steps 2 to 4 and the done step of onboarding (step 1 is /workspace/new). Step 2 saves the transport modes and home jurisdictions on the profile; step 3
 * saves the workspace's sectors through the one settings writer and seeds the notification defaults (both results are read: a refusal stays on the step
 * with its reason); step 4 is the Settings briefing card, the same part. Back, Skip for now and Continue are always reachable. The date on each step comes
 * from the auth masthead after hydration, never from a clock read in render.
 */
export function OnboardingWizard({ userId, orgId, byPriority }: { userId: string; orgId: string; byPriority: Record<string, number> | null }) {
  const [step, setStep] = useState<Step>(2);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [modes, setModes] = useState<string[]>([]);
  const [jurisdictions, setJurisdictions] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [sectors, setSectors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void browserClient()
      .from("profiles")
      .select("jurisdiction_overrides, transport_mode_overrides")
      .eq("id", userId)
      .maybeSingle()
      .then(({ data, error: readError }) => {
        if (cancelled) return;
        if (readError) setProfileError(readFailure(readError));
        else {
          if (data?.transport_mode_overrides?.length) setModes(data.transport_mode_overrides);
          if (data?.jurisdiction_overrides?.length) setJurisdictions(data.jurisdiction_overrides);
        }
        setProfileLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function next() {
    setError(null);
    if (step === 4) return setStep(5);
    setSaving(true);
    let message: string | null = null;
    if (step === 2) message = await saveProfilePatch(browserClient(), userId, { transport_mode_overrides: modes, jurisdiction_overrides: jurisdictions });
    else {
      message = (await patchWorkspaceSettings(browserClient(), orgId, "sector_profile", sectors)).error ?? (await saveNotificationPrefs(browserClient(), userId, { ...DEFAULT_NOTIFICATION_PREFS }, { seed: true }));
      if (!message) {
        useWorkspaceStore.getState().setSectorProfile(sectors);
        useSettingsStore.setState({ sectorProfile: sectors });
      }
    }
    setSaving(false);
    if (message) return setError(message);
    setStep((s) => (s + 1) as Step);
  }

  if (step === 5) {
    return (
      <AuthFrame>
        <div className={`${styles.narrow} ${styles.done}`}>
          <div aria-hidden="true" className={styles.check}>
            ✓
          </div>
          <AuthMasthead title="You're set up" dek="Your dashboard is filtered against your modes, jurisdictions and sector profile, and your briefing is conservative by default. You can revisit any of this from Account or Settings any time." />
          <div className={styles.navRight}>
            <Link href="/" className="cl-btn cl-btn--primary cl-btn--md">
              Go to dashboard
            </Link>
            <Link href="/community" className="cl-btn cl-btn--secondary cl-btn--md">
              Browse the community
            </Link>
          </div>
        </div>
      </AuthFrame>
    );
  }

  const shown = showAll ? JURISDICTIONS : JURISDICTIONS.slice(0, FIRST_JURISDICTIONS);
  const highlighted = ALL_SECTORS.filter((s) => HIGHLIGHTED_SECTOR_IDS.has(s.id));
  const rest = ALL_SECTORS.filter((s) => !HIGHLIGHTED_SECTOR_IDS.has(s.id));
  const blocked = (step === 2 && (modes.length === 0 || jurisdictions.length === 0)) || (step === 3 && sectors.length === 0);
  return (
    <AuthFrame>
      <div className={styles.column}>
        <OnboardingStepper current={step as 2 | 3 | 4} />

        {step === 2 ? (
          <>
            <AuthMasthead title="Where do you move freight?" dek="These are saved on your profile as your transport modes and home jurisdictions. Change them any time in Account, Jurisdictions." />
            <div>
              <Heading>Modes</Heading>
              <div className={styles.grid4}>
                {MODES.map((m) => (
                  <ChoiceChip key={m.id} label={m.label} pressed={modes.includes(m.id)} onToggle={() => setModes((p) => toggle(p, m.id))} />
                ))}
              </div>
            </div>
            <div>
              <Heading>{`Home jurisdictions · ${jurisdictions.length} selected`}</Heading>
              <div className={styles.grid3}>
                {shown.map((j) => (
                  <ChoiceChip key={j.id} label={j.label} pressed={jurisdictions.includes(j.id)} onToggle={() => setJurisdictions((p) => toggle(p, j.id))} />
                ))}
              </div>
              {!showAll ? (
                <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
                  {`+ ${JURISDICTIONS.length - FIRST_JURISDICTIONS} more jurisdictions`}
                </Button>
              ) : null}
            </div>
            <div className={styles.preview}>
              <p className={styles.eyebrow}>Preview · your workspace today</p>
              {byPriority ? (
                <BandTileRow gap={8}>
                  {BAND_ORDER.map((b) => (
                    <BandTile key={b.key} band={b} count={byPriority[b.priority] ?? null} loading={!profileLoaded} />
                  ))}
                </BandTileRow>
              ) : (
                <StateNote tone="error">The workspace counts did not load. Your choices still save.</StateNote>
              )}
            </div>
            {profileError ? <StateNote tone="error">Your saved choices did not load. {profileError} What you pick here replaces them.</StateNote> : null}
          </>
        ) : null}

        {step === 3 ? (
          <>
            <AuthMasthead title="Which sectors do you watch?" dek="Pick all that apply. We use these to show which items apply to you and to tailor your briefings. You can change them any time in Settings." />
            <div>
              <Heading>Highlighted niches</Heading>
              <div className={styles.grid2}>
                {highlighted.map((s) => (
                  <ChoiceChip key={s.id} label={s.label} pressed={sectors.includes(s.id)} onToggle={() => setSectors((p) => toggle(p, s.id))} />
                ))}
              </div>
            </div>
            <div className={styles.scroll}>
              <Heading>All sectors</Heading>
              <div className={styles.grid2}>
                {rest.map((s) => (
                  <ChoiceChip key={s.id} label={s.label} pressed={sectors.includes(s.id)} onToggle={() => setSectors((p) => toggle(p, s.id))} />
                ))}
              </div>
            </div>
            <p className="cl-field-hint">{sectors.length === 0 ? "Pick at least one sector to continue." : `${sectors.length} sector${sectors.length === 1 ? "" : "s"} selected.`}</p>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <AuthMasthead title="How should we brief you?" dek="We've started you off with a conservative set of defaults. Higher-volume notifications are off until you opt in. You can change these any time from Settings." />
            <BriefingScheduleSection />
          </>
        ) : null}

        {error ? <InlineErrorBanner message={`Not saved: ${error}`} /> : null}
        <div className={styles.nav}>
          {step > 2 ? (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)} disabled={saving}>
              ← Back
            </Button>
          ) : (
            <span />
          )}
          <div className={styles.navRight}>
            <Link href="/" className="cl-btn cl-btn--secondary cl-btn--md">
              Skip for now
            </Link>
            <Button variant="primary" onClick={() => void next()} disabled={saving || blocked}>
              {saving ? "Saving..." : step === 2 ? "Continue → Sectors" : step === 3 ? "Continue → Briefing" : "Finish"}
            </Button>
          </div>
        </div>
      </div>
    </AuthFrame>
  );
}
