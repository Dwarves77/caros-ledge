// Ported from old_repo/src/app/api/version/route.ts (lines 13-22)

/**
 * GET /api/version: the deployed build identity. PUBLIC AND UNAUTHENTICATED BY DOCUMENTED EXCEPTION (operator-approved 2026-07-11): it returns only the deployed git commit and the environment, so an audit can anchor a live deployment
 * to a git commit. The branch name and the repository slug are not returned (audit 2026-10-23: they are build metadata nobody outside the team needs, and a branch name can say more than the commit does). Read-only, no query parameters, no database.
 */
export function GET(): Response {
  return Response.json({ commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, env: process.env.VERCEL_ENV ?? null });
}
