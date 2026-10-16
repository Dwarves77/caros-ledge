// Ported from old_repo/src/stores/workspaceStore.ts (lines 1-49)
// Ported from old_repo/src/components/auth/AuthProvider.tsx (lines 160-170)
import { create } from "zustand";

import type { OrgRole } from "@/core/types";

interface WorkspaceState {
  orgId: string | null;
  orgName: string;
  userRole: OrgRole | null;
  /** The sectors this workspace operates in; empty means no sector-aware filtering. */
  sectorProfile: string[];
  setWorkspace: (orgId: string, orgName: string) => void;
  setUserRole: (role: OrgRole | null) => void;
  setSectorProfile: (sectors: string[]) => void;
}

/** The client's tenant identity. No hardcoded defaults: the AuthProvider seed fills it; an anonymous or workspace-less visitor sees the platform view. */
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  orgId: null,
  orgName: "",
  userRole: null,
  sectorProfile: [],
  setWorkspace: (orgId, orgName) => set({ orgId, orgName }),
  setUserRole: (userRole) => set({ userRole }),
  setSectorProfile: (sectorProfile) => set({ sectorProfile }),
}));

/** The part of the AuthProvider seed the store reads (structural, so core does not import the auth UI). */
export interface WorkspaceSeed {
  status: "resolved" | "error";
  orgId: string | null | undefined;
  orgName: string;
  role: OrgRole | null;
  sectors: string[];
}

/**
 * AuthProvider's `onSeed`. A failed identity lookup is UNKNOWN, not "no workspace": nothing is written from a non-answer.
 * A resolved seed sets the org and role when present and always sets the sector profile.
 */
export function applyWorkspaceSeed(seed: WorkspaceSeed): void {
  if (seed.status === "error") return;
  const state = useWorkspaceStore.getState();
  if (seed.orgId) state.setWorkspace(seed.orgId, seed.orgName);
  if (seed.role) state.setUserRole(seed.role);
  state.setSectorProfile(seed.sectors);
}
