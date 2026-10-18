// Ported from old_repo/src/app/community/moderation/page.tsx (lines 28-73)
// /community/moderation: the report queue. Row security narrows what the caller sees; the queue itself says which reports it may act on.
import { communityPage } from "./frame";
import { ModerationScreen } from "./screens";

export async function ModerationPage() {
  return communityPage("/community/moderation", "The moderation queue", async () => <ModerationScreen />);
}
