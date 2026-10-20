// The page sweep (IMP-119, INV-263 made mechanical): a server page is drawn healthy, every table and rpc it read is recorded, and then the page is drawn again once per read with THAT read refused. A refused read must be STATED: the
// refused draw says so (a "did not load", "could not be loaded", "Try again" or Retry that the healthy draw did not carry). A page that draws without saying so has a silent read, and a new silent read fails the build.
//
// The sweep can itself fail (G5), by three rules that make a pass mean something:
//   1. the healthy draw must not match STATED: a page whose static copy holds "Retry" would otherwise "state" a failure for every refused read, and a silent read would pass;
//   2. a refused draw that is identical to the healthy one is silent, whatever words the page holds, and a refused draw is stated only when it says MORE of it than the healthy one;
//   3. a page with no refusable read is vacuous and fails: a sweep that refused nothing proved nothing (a read that is a documented fall-back is named in `fallsBack` with its reason, and does not count).
// The world behind a page is anything that can name the reads a draw made and refuse one of them: the Community world and the workspace world adapt to the same three members. The pages of every surface run through this
// one helper (tests/surfaces/page-sweep.test.ts, tests/community/pages.test.ts), and tests/surfaces/route-sweep.test.ts requires every route in src/app to be swept or exempt with a reason.
export interface SweepWorld {
  /** The tables selected from and the rpcs called by the draws so far. */
  reads(): { tables: string[]; rpcs: string[] };
  /** Refuse every read of the table from now on. */
  failTable(table: string): void;
  /** Refuse every call of the rpc from now on. */
  failRpc(rpc: string): void;
}
export interface SweepPage {
  name: string;
  /** Draw the page over the world and return what a reader sees as text. The world has been scripted as the client of the draw by `fresh`. */
  draw(world: SweepWorld): Promise<string>;
  /** Reads whose failure is a documented fall-back that shows nothing wrong (a display gate that fails closed, a footer name that falls back to the account's). Each needs its reason beside it in the test. */
  fallsBack?: readonly string[];
  /** Reads the page makes only because a shared reader enriches rows it never draws. Each needs its reason beside it in the test. */
  notDrawn?: readonly string[];
  /** Phrases of the page's own fixed copy that hold a STATED word ("could not place on their own"). They are masked in every draw before the text is read for a stated failure; each needs its reason beside it in the test. */
  staticCopy?: readonly string[];
}
/** What a stated failure looks like in the text of a page. */
export const STATED = /did not load|could not be loaded|could not|unavailable|Try again|Retry|Application error/i;

export interface SweepResult {
  tables: string[];
  rpcs: string[];
  /** One entry per read whose refusal drew a page with no new stated failure. */
  silent: string[];
  /** Why the sweep itself proves nothing for this page (empty when it proves what it says). */
  problems: string[];
}

/** A draw that throws reaches the app's error boundary, which says so ("Application error"); a Next not-found or redirect signal is not a statement: a failed read answered 404 is a silent one. */
async function drawRefused(page: SweepPage, world: SweepWorld): Promise<string> {
  try {
    return await page.draw(world);
  } catch (e) {
    const digest = String((e as { digest?: unknown }).digest ?? "");
    if (/NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|NEXT_REDIRECT/.test(digest)) return `[${digest}]`;
    return `Application error: the page threw to the error boundary (${e instanceof Error ? e.message : String(e)})`;
  }
}

export async function sweepPage(page: SweepPage, fresh: () => SweepWorld): Promise<SweepResult> {
  const healthy = fresh();
  const healthyText = await page.draw(healthy);
  const { tables, rpcs } = healthy.reads();
  const problems: string[] = [];
  const mask = (text: string) => (page.staticCopy ?? []).reduce((t, phrase) => t.split(phrase).join(" "), text);
  const statedCount = (text: string) => (mask(text).match(new RegExp(STATED.source, "gi")) ?? []).length;
  const already = STATED.exec(mask(healthyText));
  if (already) problems.push(`the healthy draw already matches STATED ("${already[0]}"): every refused read would count as stated, so the sweep proves nothing`);
  const refusableTables = tables.filter((t) => !(page.notDrawn ?? []).includes(t));
  const refusableRpcs = rpcs.filter((r) => !(page.fallsBack ?? []).includes(r) && !(page.notDrawn ?? []).includes(r));
  if (refusableTables.length + refusableRpcs.length === 0) problems.push("the page makes no refusable read: the sweep is vacuous");
  const silent: string[] = [];
  // A refused read is stated when the refused draw says more of it than the healthy one: a phrase the page always carries ("Retry" in a menu) is not a statement about this read.
  const stated = (text: string) => statedCount(text) > statedCount(healthyText);
  for (const table of refusableTables) {
    const w = fresh();
    w.failTable(table);
    if (!stated(await drawRefused(page, w))) silent.push(`table ${table}`);
  }
  for (const rpc of refusableRpcs) {
    const w = fresh();
    w.failRpc(rpc);
    if (!stated(await drawRefused(page, w))) silent.push(`rpc ${rpc}`);
  }
  return { tables, rpcs, silent, problems };
}
