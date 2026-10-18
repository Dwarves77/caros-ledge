// Ported from old_repo/src/app/community/profile/page.tsx (lines 18-54)
// /community/profile: your Community identity and verification. The sidebar links here (the page had no inbound link).
import { communityPage } from "./frame";
import { ProfileScreen } from "./screens";

export async function ProfilePage() {
  return communityPage("/community/profile", "Your community profile", async () => <ProfileScreen />);
}
