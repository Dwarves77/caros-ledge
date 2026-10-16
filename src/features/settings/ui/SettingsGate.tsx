"use client";

// Ported from old_repo/src/components/settings/OrganisationProfileSection.tsx (lines 88-111)
import type { ReactNode } from "react";

import { StateNote } from "@/ui";
import { useAuth } from "@/features/auth/ui/AuthProvider";

import { reloadSettings, useSettingsStore } from "../state/settings-store";

/**
 * What a settings section shows until the workspace's settings are in: the loading line, the failure with Retry (a failed read is never the defaults
 * shown as if saved), or the sentence for a reader with no workspace. Once loaded, the section.
 */
export function SettingsGate({ children }: { children: ReactNode }) {
  const loaded = useSettingsStore((s) => s.loaded);
  const loadError = useSettingsStore((s) => s.loadError);
  const { orgId, identityStatus } = useAuth();
  if (loadError) {
    return (
      <StateNote tone="error" action={{ label: "Retry", onClick: reloadSettings }}>
        This workspace&apos;s settings did not load: {loadError}
      </StateNote>
    );
  }
  if (loaded) return <>{children}</>;
  if (identityStatus === "resolved" && !orgId) return <p className="cl-field-hint">Join or create a workspace to change its settings.</p>;
  return <p className="cl-field-hint">Loading settings...</p>;
}
