// Ported from old_repo/src/components/ui/tagPopoverKeyboard.ts (lines 1-87)
import { wrapIndex } from "@/ui/focus";

export interface TagOption {
  id: string;
  name: string;
  itemCount: number;
}

/** Existing tags matching the query (case-insensitive substring; an empty query matches everything). */
export function visibleRows(tags: TagOption[], query: string): TagOption[] {
  const q = query.trim().toLowerCase();
  return q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags;
}

/** True when some tag's name equals the query exactly, case-insensitively: the comparison the database's generated name_key makes (migration 313), so this never disagrees with the server about what already exists. */
function hasExactMatch(tags: TagOption[], query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || tags.some((t) => t.name.trim().toLowerCase() === q);
}

/** The footer "Create" row is shown when the query has no exact match. */
export const showCreateRow = (tags: TagOption[], query: string): boolean => query.trim().length > 0 && !hasExactMatch(tags, query);

/** Total selectable rows: the filtered tags plus the create row. */
export const rowCount = (tags: TagOption[], query: string): number => visibleRows(tags, query).length + (showCreateRow(tags, query) ? 1 : 0);

/** Up and down with wraparound; -1 is nothing highlighted (the initial state, and the state once the list is empty). */
export function moveHighlight(current: number, direction: 1 | -1, count: number): number {
  if (count === 0) return -1;
  return current < 0 ? (direction === 1 ? 0 : count - 1) : wrapIndex(count, current, direction);
}

/** Keep a highlight in range after typing narrows or widens the list; -1 when the list is empty. */
export const clampHighlight = (current: number, count: number): number => (count === 0 || current < 0 ? -1 : Math.min(current, count - 1));

export type EnterAction = { type: "none" } | { type: "toggle"; tagId: string } | { type: "create"; name: string };

/** Enter toggles the highlighted tag (multi-select; the popover stays open) or creates the typed name from the footer row. Nothing highlighted does nothing: Enter never applies a random row. */
export function resolveEnterAction(tags: TagOption[], query: string, highlight: number): EnterAction {
  if (highlight < 0) return { type: "none" };
  const visible = visibleRows(tags, query);
  const hit = visible[highlight];
  if (hit) return { type: "toggle", tagId: hit.id };
  return showCreateRow(tags, query) && highlight === visible.length ? { type: "create", name: query.trim() } : { type: "none" };
}

export type BackspaceAction = { type: "none" } | { type: "removeLast"; tagId: string };

/** Backspace on an EMPTY input removes the most recently applied tag (`appliedInOrder` is oldest to newest); in a non-empty input it is plain text editing. */
export function resolveBackspaceAction(query: string, appliedInOrder: string[]): BackspaceAction {
  const last = appliedInOrder[appliedInOrder.length - 1];
  return query.length > 0 || last === undefined ? { type: "none" } : { type: "removeLast", tagId: last };
}
