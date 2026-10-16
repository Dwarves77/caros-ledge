"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 82-108)
// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 133-257)
import { useCallback, useEffect, useState } from "react";

import { browserClient } from "@/core/db/browser";
import { requestJson } from "@/core/http/request-json";

import { saveProfilePatch, type ProfilePatch } from "./profile-patch";

export interface ProfileRow {
  full_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  jurisdiction_overrides: string[];
  transport_mode_overrides: string[];
  verifier_status: "none" | "pending" | "active" | "revoked";
  verifier_since: string | null;
  created_at: string | null;
}
export interface OrgPayload {
  org: { id: string; name: string; slug: string; plan: string; created_at: string };
  caller_role: "owner" | "admin" | "member" | "viewer";
  owner: { user_id: string; display_name: string; owner_since: string } | null;
  member_count: number;
}
export interface AccountState {
  loading: boolean;
  profile: ProfileRow;
  /** The workspace's sectors (workspace_settings.sector_profile), the same row the relevance lens reads. */
  sectors: string[];
  org: OrgPayload | null;
  /** One message per read that failed; a failed read is shown with Retry, never rendered as an empty profile or a zero. */
  errors: { profile?: string; sectors?: string; org?: string };
}

const EMPTY: ProfileRow = { full_name: null, bio: null, avatar_url: null, jurisdiction_overrides: [], transport_mode_overrides: [], verifier_status: "none", verifier_since: null, created_at: null };
const COLUMNS = "full_name, bio, avatar_url, jurisdiction_overrides, transport_mode_overrides, verifier_status, verifier_since, created_at";

/**
 * The account page's one loader: the profile, the workspace's sectors and the organisation (plan, member count, the owner) in ONE effect, instead of
 * four effects that each fetched a field. Each read reports its own failure. The two writes (a profile patch, a verifier request) go through the one
 * strict writer and the SECURITY DEFINER rpc, and local state follows what the server answered.
 */
export function useAccount(userId: string, orgId: string | null) {
  const [state, setState] = useState<AccountState>({ loading: true, profile: EMPTY, sectors: [], org: null, errors: {} });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const client = browserClient();
    void Promise.all([
      client.from("profiles").select(COLUMNS).eq("id", userId).maybeSingle(),
      orgId ? client.from("workspace_settings").select("sector_profile").eq("org_id", orgId).maybeSingle() : Promise.resolve(null),
      orgId ? requestJson<OrgPayload>(`/api/orgs/${orgId}`) : Promise.resolve(null),
    ]).then(([p, s, o]) => {
      if (cancelled) return;
      const errors: AccountState["errors"] = {};
      if (p.error) errors.profile = p.error.message;
      if (s?.error) errors.sectors = s.error.message;
      if (o && !o.ok) errors.org = o.error ?? "The organisation could not be loaded.";
      const row = p.data as Partial<ProfileRow> | null;
      setState({
        loading: false,
        profile: row ? { ...EMPTY, ...row, jurisdiction_overrides: row.jurisdiction_overrides ?? [], transport_mode_overrides: row.transport_mode_overrides ?? [], verifier_status: row.verifier_status ?? "none" } : EMPTY,
        sectors: ((s?.data as { sector_profile?: string[] | null } | null)?.sector_profile ?? []) as string[],
        org: o?.ok ? o.data : null,
        errors,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [userId, orgId, attempt]);

  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    setAttempt((n) => n + 1);
  }, []);

  /** Write the reader's own profile row; the message on failure, null when it landed. */
  const saveProfile = useCallback(
    async (patch: ProfilePatch): Promise<string | null> => {
      const message = await saveProfilePatch(browserClient(), userId, patch);
      if (!message) setState((s) => ({ ...s, profile: { ...s.profile, ...patch } as ProfileRow }));
      return message;
    },
    [userId],
  );

  /** Asking to be verified is the rpc request_verification (migration 367), which sets 'pending' for the caller only; local state follows the status it returns. */
  const requestVerification = useCallback(async (): Promise<string | null> => {
    const { data, error } = await browserClient().rpc("request_verification");
    if (error) return error.message;
    if (data === "pending") setState((s) => ({ ...s, profile: { ...s.profile, verifier_status: "pending" } }));
    return null;
  }, []);

  return { ...state, reload, saveProfile, requestVerification };
}
