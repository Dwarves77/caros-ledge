// Ported from old_repo/src/components/onboarding/NoWorkspaceLanding.tsx (lines 111-125)
/** The 64-hex token out of a pasted invitation link or the token itself; null when the text holds none. */
export const tokenFrom = (text: string): string | null => /[0-9a-f]{64}/i.exec(text)?.[0].toLowerCase() ?? null;
