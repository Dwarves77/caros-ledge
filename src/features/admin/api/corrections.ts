// Ported from old_repo/src/components/admin/corrections/load-all.mjs (lines 12-60)
import { loadAllCorrections } from "../corrections/load-all";

import { adminRoute, reply } from "./shared";

/** The all-corrections list (every item, newest first, with state, orphan mark and item title) on the service client behind the admin gate. The per-item list, create and revoke are the corrections feature's own handlers. */
export const GET = adminRoute("/api/admin/corrections", async (admin) => reply(admin, await loadAllCorrections(admin.service())));
