"use client";

import { useState } from "react";

import { AccountPage } from "@/features/account/ui/AccountPage";
import { InvitationLandingPage } from "@/features/onboarding/ui/InvitationLandingPage";
import { NoWorkspaceLanding } from "@/features/onboarding/ui/NoWorkspaceLanding";
import { OnboardingWizard } from "@/features/onboarding/ui/OnboardingWizard";
import { SettingsPage } from "@/features/settings/ui/SettingsPage";
import type { SettingsData } from "@/features/settings/server/settings-data";
import type { ArchiveRow } from "@/features/workspace/archive-types";
import { ArchiveDialog } from "@/features/workspace/ui/ArchiveDialog";
import { ArchiveViewer } from "@/features/workspace/ui/ArchiveViewer";
import { DetailTagRow } from "@/features/workspace/ui/DetailTagRow";
import { Button } from "@/ui";

const NOW = "2026-10-15T00:00:00.000Z";
const ARCHIVE: ArchiveRow[] = [
  // The structure the member account has on production (one team-archived item, Expired), so the settings fixture parity compares like with like.
  { title: "EU CBAM", href: "/regulations/t1", itemId: "t1", scope: "team", reason: "expired", note: null, archivedAt: "2026-04-28T00:00:00Z", replacement: null },
  { title: "FuelEU Maritime", href: "/regulations/o3", itemId: "o3", scope: "team", reason: "superseded", note: null, archivedAt: "2026-09-01T00:00:00Z", replacement: { title: "FuelEU Maritime, 2027 text", href: "/regulations/o4" } },
  { title: "Old port rule", href: "/regulations/o9", itemId: "o9", scope: "personal", reason: null, note: "Not relevant to our lanes", archivedAt: "2026-09-02T00:00:00Z", replacement: null },
];
const SETTINGS: SettingsData = {
  archive: { rows: ARCHIVE, error: null, truncated: false },
  supersessions: { rows: [{ key: "s1", severity: "major", date: "2026-08-01", old: { title: "ReFuelEU Aviation, 2023 text", href: "/regulations/o5" }, new: { title: "ReFuelEU Aviation, 2026 text", href: "/regulations/o6" }, note: "Mandate raised." }], error: null, truncated: false },
};

/** One workspace screen per `?screen=`, with static props; the data it reads arrives from the smoke's mocked responses. */
export function WorkspaceParts({ screen }: { screen: string }) {
  const [archiving, setArchiving] = useState(false);
  const [tagging, setTagging] = useState(true);
  return (
    <div data-fx="workspace">
      {screen === "account" ? <AccountPage userId="u-1" userEmail="smoke@example.invalid" orgId="o-1" orgName="Dietl / Rockit" role="owner" nowIso={NOW} initialTab="personal" /> : null}
      {screen === "account-members" ? <AccountPage userId="u-1" userEmail="smoke@example.invalid" orgId="o-1" orgName="Dietl / Rockit" role="owner" nowIso={NOW} initialTab="members" /> : null}
      {screen === "settings" ? <SettingsPage userId="u-1" nowIso={NOW} orgName="Dietl / Rockit" data={SETTINGS} /> : null}
      {screen === "landing" ? <NoWorkspaceLanding userId="u-1" userEmail="smoke@example.invalid" /> : null}
      {screen === "wizard" ? <OnboardingWizard userId="u-1" orgId="o-1" byPriority={{ CRITICAL: 15, HIGH: 13, MODERATE: 1135, LOW: 7 }} /> : null}
      {screen === "invitation" ? <InvitationLandingPage token={"a".repeat(64)} userEmail="smoke@example.invalid" /> : null}
      {screen === "workspace" ? (
        <main style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <Button id="fx-archive" variant="secondary" onClick={() => setArchiving(true)}>
              Archive this item
            </Button>
            {archiving ? <ArchiveDialog itemId="o3" title="FuelEU Maritime" onClose={() => setArchiving(false)} /> : null}
          </div>
          <div>
            <Button variant="secondary" onClick={() => setTagging((v) => !v)}>
              + Tag
            </Button>
            <DetailTagRow itemId="o3" open={tagging} onOpenChange={setTagging} />
          </div>
          <ArchiveViewer rows={ARCHIVE} />
        </main>
      ) : null}
    </div>
  );
}
