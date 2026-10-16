// Ported from old_repo/src/lib/telemetry/surface-health.mjs (lines 1-67)

export const MUST_HAVE_SURFACES = ["dashboard", "regulations", "market", "research", "operations"] as const;
export const ZERO_LEGAL_SURFACES = ["community", "map", "assistant-config", "onboarding-config"] as const;
/** The surface list, exported once: the probe route reads it, so the hard-coded twin the old route kept is gone. */
export const ALL_SURFACES: readonly string[] = [...MUST_HAVE_SURFACES, ...ZERO_LEGAL_SURFACES];

export interface SurfaceResult {
  ok: boolean;
  backing_rows: number | null;
  error: string | null;
}
/** One surface probe. An unknown name fails loudly (a typo in the probe table must not read green); a must-have surface with zero rows fails; a missing count fails. */
export function evaluateSurface(name: string, rows: number | null | undefined, error?: string | null): SurfaceResult {
  if (!ALL_SURFACES.includes(name)) return { ok: false, backing_rows: rows ?? null, error: `unknown surface: ${name}` };
  if (error) return { ok: false, backing_rows: rows ?? null, error };
  const count = typeof rows === "number" && Number.isFinite(rows) ? rows : null;
  if (count === null) return { ok: false, backing_rows: null, error: "no count returned" };
  if ((MUST_HAVE_SURFACES as readonly string[]).includes(name) && count === 0) return { ok: false, backing_rows: 0, error: "must-have surface has zero backing rows" };
  return { ok: true, backing_rows: count, error: null };
}
/** Overall health: every surface ok and every rpc probe ok; no surfaces at all is not healthy. */
export function overallOk(surfaces: Record<string, { ok: boolean }> | null | undefined, rpcs: Record<string, { ok: boolean }> | null | undefined): boolean {
  const s = Object.values(surfaces ?? {});
  return s.length > 0 && s.every((x) => x?.ok === true) && Object.values(rpcs ?? {}).every((r) => r?.ok === true);
}
/** seed_leak is false iff the dashboard provably renders from real rows (the seed fallback is deleted, but a zero-row dashboard is the same customer-visible symptom). */
export const seedLeak = (dashboardRows: number | null | undefined): boolean => !(typeof dashboardRows === "number" && dashboardRows > 0);
