// Ported from old_repo/src/app/api/version/route.ts (lines 13-22)

/**
 * GET /api/version: the deployed build identity. PUBLIC AND UNAUTHENTICATED BY DOCUMENTED EXCEPTION (operator-approved 2026-07-11): it returns only the deployed git commit, ref,
 * repo and environment, non-sensitive build metadata already in the shipped client bundle, so an audit can anchor a live deployment to a git ref. Read-only, no query parameters, no database.
 */
export function GET(): Response {
  return Response.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, ref: process.env.VERCEL_GIT_COMMIT_REF ?? null, repo: process.env.VERCEL_GIT_REPO_SLUG ?? null, env: process.env.VERCEL_ENV ?? null });
}
