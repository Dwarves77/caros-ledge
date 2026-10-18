// Ported from old_repo/src/app/community/discover/page.tsx (lines 19-75)
// /community/discover: follow spine entities and read every thread that touches them, across every group you can read. The entity search is the picker's own route now, so the page reads nothing of its own.
import { communityPage } from "./frame";
import { DiscoverScreen } from "./screens";

export async function DiscoverPage() {
  return communityPage("/community/discover", "Discover", async () => <DiscoverScreen />);
}
