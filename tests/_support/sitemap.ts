// The sitemap walk as the sweep stage reaches it: through walkSource (feed discovery first), asserting that no feed was found so the sitemap walk is what ran.
import { walkSource, type SitemapDeps, type SitemapOpts } from "@/features/sources/walkers/sitemap";

export async function walkSitemap(deps: SitemapDeps, opts: SitemapOpts) {
  const out = await walkSource(deps, { ...opts, sourceUrl: opts.baseUrl });
  if (out.kind !== "sitemap") throw new Error("the fixture served a feed; the sitemap walk did not run");
  return out;
}
