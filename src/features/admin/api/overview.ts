// Ported from old_repo/src/components/admin/AdminDashboard.tsx (lines 280-306)
import { readDashboard } from "../read/dashboard";
import { readProvisional, readSources } from "../read/sources";

import { adminRoute, reply } from "./shared";

/** The console's refresh: the same reads the first paint made (organisations, members, staged updates, attention and counts), each failing on its own, on the service client behind the admin gate. */
export const getOverview = adminRoute("/api/admin/overview", async (admin) => {
  const d = await readDashboard(admin.service(), new Date(performance.timeOrigin + performance.now()).toISOString());
  const { sources: _s, provisional: _p, ...rest } = d;
  void _s;
  void _p;
  return reply(admin, rest);
});

/** The source registry and the provisional queue, whole. A failed read is an error status; the registry never answers empty because it could not be read. */
export const getSources = adminRoute("/api/admin/sources", async (admin) => {
  const db = admin.service();
  const [sources, provisional] = await Promise.all([readSources(db), readProvisional(db)]);
  return reply(admin, { sources, provisional });
});
