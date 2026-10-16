// Ported from old_repo/src/components/profile/NotificationPreferences.tsx (lines 29-45)
// Ported from old_repo/src/components/profile/NotificationPreferences.tsx (lines 109-175)
// Ported from old_repo/src/components/onboarding/OnboardingWizard.tsx (lines 190-199)
import type { Db } from "@/core/db/clients";

export interface NotificationPrefs {
  enabled: boolean;
  on_mention: boolean;
  on_reply_in_my_threads: boolean;
  on_new_post_in_joined_groups: boolean;
  /** Always on: you must be reachable when invited. */
  on_invite: boolean;
  channels: string[];
}

/** The conservative defaults: higher-volume notices are off until the reader opts in. The one place they are written, for the preferences panel and the onboarding seed. */
export const DEFAULT_NOTIFICATION_PREFS: Readonly<NotificationPrefs> = Object.freeze({ enabled: true, on_mention: true, on_reply_in_my_threads: true, on_new_post_in_joined_groups: false, on_invite: true, channels: ["in_app"] });

export type SwitchKey = "enabled" | "on_mention" | "on_reply_in_my_threads" | "on_new_post_in_joined_groups";
export const SWITCHES: ReadonlyArray<{ key: SwitchKey; label: string; description: string }> = [
  { key: "enabled", label: "Notifications enabled", description: "Master switch" },
  { key: "on_mention", label: "Someone @mentions you", description: "Direct mentions in any room" },
  { key: "on_reply_in_my_threads", label: "Replies in your threads", description: "When someone replies to a post you started" },
  { key: "on_new_post_in_joined_groups", label: "New posts in groups you've joined", description: "Higher volume, off by default" },
];

const COLUMNS = "enabled, on_mention, on_reply_in_my_threads, on_new_post_in_joined_groups, on_invite, channels";

/** The reader's preferences. No row yet is the defaults (a new account); a failed read is an error and the defaults are NOT shown as saved settings. */
export async function readNotificationPrefs(client: Db, userId: string): Promise<{ prefs: NotificationPrefs; error: string | null }> {
  const { data, error } = await client.from("notification_preferences").select(COLUMNS).eq("user_id", userId).maybeSingle();
  if (error) return { prefs: { ...DEFAULT_NOTIFICATION_PREFS }, error: error.message };
  const d = (data ?? {}) as Partial<NotificationPrefs>;
  return {
    prefs: {
      enabled: d.enabled ?? true,
      on_mention: d.on_mention ?? true,
      on_reply_in_my_threads: d.on_reply_in_my_threads ?? true,
      on_new_post_in_joined_groups: d.on_new_post_in_joined_groups ?? false,
      on_invite: d.on_invite ?? true,
      channels: d.channels ?? ["in_app"],
    },
    error: null,
  };
}

/** Write the preferences. `seed` leaves an existing row alone (the onboarding default). Returns the failure message, or null when it landed: a caller rolls its switch back on a message. */
export async function saveNotificationPrefs(client: Db, userId: string, prefs: NotificationPrefs, opts: { seed?: boolean; now?: () => string } = {}): Promise<string | null> {
  const { error } = await client.from("notification_preferences").upsert({ user_id: userId, ...prefs, updated_at: (opts.now ?? (() => new Date().toISOString()))() }, { onConflict: "user_id", ignoreDuplicates: opts.seed === true });
  return error ? error.message : null;
}
