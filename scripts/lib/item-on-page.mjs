// The ONE judgement of "this page shows this item": the page drew the brief (the typed marker data-audit="detail-section-head" at least once) AND states the item it shows (the typed attribute data-item-id on the detail root,
// src/ui/detail/DetailShell.tsx, carrying the item's uuid). The landing URL is never judged: a uuid URL redirects to the item's legacy slug (src/core/detail/id-redirect.ts). Shared by scripts/runs/visible.mjs and
// scripts/ci/live/checks.mjs so the two cannot diverge (VISIBLE-FIX-2: the live check kept asserting the uuid was in the URL). No page text is matched (ADR-053).
export const MARKER = '[data-audit="detail-section-head"]';
export const ITEM_ATTR = "data-item-id";

/** The finding for one opened page { status, finalUrl, markers, itemId, error? }, or null when it drew the brief and states the item. Pure. */
export function itemOnPageFinding(id, path, page) {
  if (!page || page.error) return `${id}: ${path} did not load (${page?.error ?? "no response"})`;
  if (page.status >= 400) return `${id}: ${path} answered HTTP ${page.status}`;
  if (!(page.markers > 0)) return `${id}: ${path} (ended at ${page.finalUrl}) drew no ${MARKER}: the brief is not shown`;
  return page.itemId === id ? null : `${id}: ${path} (ended at ${page.finalUrl}) shows ${page.itemId ? `item ${page.itemId}` : `no ${ITEM_ATTR}`}, not the item`;
}
