// Ported from old_repo/src/lib/account/initial-tab.ts (lines 1-17)
export const PROFILE_TAB_KEYS = ["personal", "organization", "members", "sectors", "jurisdictions", "verifier", "activity"] as const;

export type ProfileTabKey = (typeof PROFILE_TAB_KEYS)[number];

/** `?tab=` to a profile tab key; anything else is the first tab. */
export function resolveInitialProfileTab(rawTabParam: string | null | undefined): ProfileTabKey {
  return (PROFILE_TAB_KEYS as readonly string[]).includes(rawTabParam ?? "") ? (rawTabParam as ProfileTabKey) : "personal";
}
