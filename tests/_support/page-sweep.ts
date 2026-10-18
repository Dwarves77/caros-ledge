// The page sweep (IMP-119, INV-263 made mechanical): a server page is drawn healthy, every table and rpc it read is recorded, and then the page is drawn again once per read with THAT read refused; a page that draws without
// saying so (no "did not load", "could not be loaded", "Try again" or Retry in what it shows) has a silent read, and a new silent read fails the build. The world behind a page is anything that can name the reads a
// draw made and refuse one of them: the Community world and the workspace world adapt to the same three members. The pages of every surface run through this one helper (tests/surfaces/page-sweep.test.ts, tests/community/pages.test.ts).
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
}
/** What a stated failure looks like in the text of a page. */
export const STATED = /did not load|could not be loaded|could not|unavailable|Try again|Retry|Application error/i;

export interface SweepResult {
  tables: string[];
  rpcs: string[];
  /** One entry per read whose refusal drew a page with no stated failure. */
  silent: string[];
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
  await page.draw(healthy);
  const { tables, rpcs } = healthy.reads();
  const silent: string[] = [];
  for (const table of tables.filter((t) => !(page.notDrawn ?? []).includes(t))) {
    const w = fresh();
    w.failTable(table);
    if (!STATED.test(await drawRefused(page, w))) silent.push(`table ${table}`);
  }
  for (const rpc of rpcs.filter((r) => !(page.fallsBack ?? []).includes(r) && !(page.notDrawn ?? []).includes(r))) {
    const w = fresh();
    w.failRpc(rpc);
    if (!STATED.test(await drawRefused(page, w))) silent.push(`rpc ${rpc}`);
  }
  return { tables, rpcs, silent };
}
