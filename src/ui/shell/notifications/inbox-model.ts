// Ported from old_repo/src/components/community/NotificationsList.tsx (lines 23-300)
// The inbox's pure state changes, so a rollback is one function and is tested: marking one or all read changes the ITEMS and the COUNT together, and a failed write puts both back (the old list rolled the count
// back for "mark all" and never the items). The unread count is the server's number, not the length of the page on screen.
export interface InboxItem {
  id: string;
  kind: string;
  payload: { title?: string; body?: string; link?: string } & Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}
export interface InboxState {
  items: InboxItem[];
  unread: number;
  next: string | null;
}

export const emptyInbox: InboxState = { items: [], unread: 0, next: null };

/** Mark one item read at `at`; the count falls by one only when the item was unread and on screen. Returns the same state when there is nothing to do. */
export function markRead(state: InboxState, id: string, at: string): InboxState {
  const target = state.items.find((n) => n.id === id);
  if (!target || target.read_at) return state;
  return { ...state, items: state.items.map((n) => (n.id === id ? { ...n, read_at: at } : n)), unread: Math.max(0, state.unread - 1) };
}

/** Mark everything read: every item on screen, and the count to zero. */
export const markAllRead = (state: InboxState, at: string): InboxState => ({ ...state, items: state.items.map((n) => (n.read_at ? n : { ...n, read_at: at })), unread: 0 });

/** Append an older page; an item already on screen is not repeated. */
export function appendOlder(state: InboxState, page: { notifications: InboxItem[]; next_cursor: string | null }): InboxState {
  const seen = new Set(state.items.map((n) => n.id));
  return { ...state, items: [...state.items, ...page.notifications.filter((n) => !seen.has(n.id))], next: page.next_cursor };
}

/** The title the row draws: the payload's own, else the kind's name. Never a raw id or a table name. */
export const KIND_LABEL: Readonly<Record<string, string>> = { mention: "Mention", reply: "Reply", invite: "Invitation", moderation: "Moderation", archive: "Archived", assignment: "Assigned" };
export const titleOf = (n: InboxItem): string => (typeof n.payload.title === "string" && n.payload.title ? n.payload.title : (KIND_LABEL[n.kind] ?? "Notification"));

/** Only an in-app path is followed from a notification; anything else (another site, a protocol-relative address) is ignored. */
export const safeLink = (link: unknown): string | null => (typeof link === "string" && link.startsWith("/") && !link.startsWith("//") ? link : null);
