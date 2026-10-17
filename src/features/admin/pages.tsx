// Ported from old_repo/src/app/admin/page.tsx (lines 188-238)
// Ported from old_repo/src/app/admin/items/[id]/page.tsx (lines 16-32)
// Ported from old_repo/src/app/admin/factors/page.tsx (lines 61-120)
// Ported from old_repo/src/app/admin/inferences/page.tsx (lines 10-71)
import { notFound } from "next/navigation";

import { requirePlatformAdmin } from "@/core/auth/platform-admin";
import { serviceClient, type Db } from "@/core/db";
import { isUuid } from "@/core/http/parse";

import { readFactors, readInferences } from "./api/runtime";
import { loadItemTargets } from "./corrections/load-item-targets";
import { readDashboard } from "./read/dashboard";
import { AdminPage } from "./ui/AdminPage";
import { FactorsPage, type FactorRow } from "./ui/FactorsPage";
import { InferencesPage } from "./ui/InferencesPage";
import { ItemCorrectionsPage } from "./ui/ItemCorrectionsPage";
import { PartsGallery } from "./ui/parts/PartsGallery";
import { WorkspaceParts } from "./ui/parts/WorkspaceParts";

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** The service client behind the admin gate, or the one stated reason there is none (a deployment without the service key answers it, never a crash). */
function service(): { db: Db } | { unavailable: string } {
  try {
    return { db: serviceClient() };
  } catch (e) {
    return { unavailable: reason(e) };
  }
}

/** /admin: the platform-admin gate FIRST (no session goes to /login, a signed-in non-admin to /), then the console's reads on the service client, each failing on its own. */
export async function AdminRoute() {
  const { userId, email } = await requirePlatformAdmin("/admin");
  const nowIso = new Date().toISOString();
  const s = service();
  return <AdminPage userId={userId} userEmail={email} nowIso={nowIso} initial={"db" in s ? await readDashboard(s.db, nowIso) : null} {...("unavailable" in s ? { unavailable: s.unavailable } : {})} />;
}

/** /admin/items/[id]: the admin gate runs before any read, and a refusal means the item is never read. */
export async function ItemCorrectionsRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePlatformAdmin(`/admin/items/${id}`);
  if (!isUuid(id)) notFound();
  const s = service();
  if (!("db" in s)) return <AdminPage userId="" userEmail="" nowIso={new Date().toISOString()} initial={null} unavailable={s.unavailable} />;
  const targets = await loadItemTargets(s.db, id);
  if (!targets) notFound();
  return <ItemCorrectionsPage targets={targets} />;
}

/** The result of one read as a value, so the page is built outside any try block. */
async function attempt<T>(read: () => Promise<T>): Promise<{ data: T; error: null } | { data: null; error: string }> {
  try {
    return { data: await read(), error: null };
  } catch (e) {
    return { data: null, error: reason(e) };
  }
}

export async function FactorsRoute() {
  await requirePlatformAdmin("/admin/factors");
  const nowIso = new Date().toISOString();
  const s = service();
  if (!("db" in s)) return <FactorsPage rows={null} error={s.unavailable} nowIso={nowIso} />;
  const r = await attempt(() => readFactors(s.db));
  return <FactorsPage rows={r.data as unknown as FactorRow[] | null} error={r.error} nowIso={nowIso} />;
}

export async function InferencesRoute() {
  await requirePlatformAdmin("/admin/inferences");
  const nowIso = new Date().toISOString();
  const s = service();
  if (!("db" in s)) return <InferencesPage data={null} error={s.unavailable} nowIso={nowIso} />;
  const r = await attempt(() => readInferences(s.db));
  return <InferencesPage data={r.data as unknown as Parameters<typeof InferencesPage>[0]["data"]} error={r.error} nowIso={nowIso} />;
}

/** /admin/parts: the parts gallery behind the admin guard (IMP-060): every row and card part, and the workspace screens, mounted with fixtures. The same components the UX smoke mounts. */
export async function PartsRoute() {
  await requirePlatformAdmin("/admin/parts");
  return <PartsGallery />;
}
export async function WorkspacePartsRoute({ searchParams }: { searchParams: Promise<{ screen?: string }> }) {
  await requirePlatformAdmin("/admin/parts/workspace");
  return <WorkspaceParts screen={(await searchParams).screen ?? "account"} />;
}
