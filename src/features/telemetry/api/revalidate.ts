// Ported from old_repo/src/app/api/revalidate/route.ts (lines 34-65)
// Ported from old_repo/src/app/api/cache/revalidate-item/route.ts (lines 21-48)
import { revalidateTag } from "next/cache";
import { z } from "zod";

import { route } from "@/core/http/errors";
import { workerAuthGuard } from "@/core/http/guard";
import { parseJson } from "@/core/http/parse";
import { checkRateLimit, WORKER_FLUSH_BUDGET } from "@/core/http/rate-limit";

const MAX_TAGS = 50;
const body = z.object({ tags: z.array(z.string().min(1)).min(1).max(MAX_TAGS) });

/**
 * POST /api/revalidate { tags }: the one cache-flush route (the per-item route is gone; its caller posts `[itemTag(id), INTEL_ITEMS_TAG]`). The worker secret, then the shared limiter,
 * then 1 to 50 non-empty tags, each flushed with revalidateTag(tag, "max"). Tags only, never a path.
 */
export const POST = route("/api/revalidate", async (request) => {
  const denied = workerAuthGuard(request);
  if (denied) return denied;
  const limited = await checkRateLimit("worker:/api/revalidate", Date.now(), undefined, WORKER_FLUSH_BUDGET);
  if (limited) return limited;
  const { tags } = await parseJson(request, body);
  for (const tag of tags) revalidateTag(tag, "max");
  return Response.json({ revalidated: true, tags });
});
