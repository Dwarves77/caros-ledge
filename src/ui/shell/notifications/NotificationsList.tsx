"use client";

// Ported from old_repo/src/components/community/NotificationsList.tsx (lines 23-481)
// The platform inbox: the list (20 at a time), mark one read by opening it, mark all read, load older. A failed load says so with Retry (never an empty inbox); a failed mark restores the items AND the count together;
// a failed "load older" says so and keeps its button (the old list stopped silently). Every control is 44 px.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { requestJson } from "@/core/http/request-json";

import { Button } from "../../Button";
import { RelativeTime } from "../../RelativeTime";
import { StateNote } from "../../StateNote";

import { appendOlder, emptyInbox, markAllRead, markRead, safeLink, titleOf, type InboxItem, type InboxState } from "./inbox-model";

const PATH = "/api/community/notifications";
const PAGE = 20;
type Page = { notifications: InboxItem[]; unread_count: number; next_cursor: string | null };

export function NotificationsList({ onUnreadChange, onClose }: { onUnreadChange: (n: number) => void; onClose: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<InboxState>(emptyInbox);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [busy, setBusy] = useState<"older" | "all" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef(state);
  useEffect(() => {
    live.current = state;
  });

  const load = useCallback(async () => {
    setStatus("loading");
    const r = await requestJson<Page>(`${PATH}?limit=${PAGE}`);
    if (!r.ok || !r.data) return setStatus("failed");
    setState({ items: r.data.notifications, unread: r.data.unread_count, next: r.data.next_cursor });
    onUnreadChange(r.data.unread_count);
    setStatus("ready");
  }, [onUnreadChange]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the load is the synchronisation with the server
    void load();
  }, [load]);

  const apply = (next: InboxState) => {
    setState(next);
    onUnreadChange(next.unread);
  };

  async function open(n: InboxItem) {
    const before = live.current;
    const at = new Date().toISOString();
    if (!n.read_at) {
      apply(markRead(before, n.id, at));
      const r = await requestJson(`${PATH}/${n.id}`, { method: "POST", body: { action: "mark_read" } });
      if (!r.ok) {
        apply(before);
        setNote("That notification could not be marked read. Nothing was changed.");
        return;
      }
    }
    const link = safeLink(n.payload.link);
    if (link) {
      onClose();
      router.push(link);
    }
  }

  async function readAll() {
    const before = live.current;
    setBusy("all");
    apply(markAllRead(before, new Date().toISOString()));
    const r = await requestJson(PATH, { method: "POST", body: { action: "mark_all_read" } });
    setBusy(null);
    if (!r.ok) {
      apply(before);
      setNote("Notifications could not be marked read. Nothing was changed.");
    }
  }

  async function older() {
    if (!state.next) return;
    setBusy("older");
    setNote(null);
    const r = await requestJson<Page>(`${PATH}?limit=${PAGE}&before=${encodeURIComponent(state.next)}`);
    setBusy(null);
    if (!r.ok || !r.data) return setNote("Older notifications could not be loaded.");
    apply(appendOlder(live.current, { notifications: r.data.notifications, next_cursor: r.data.next_cursor }));
  }

  if (status === "loading") return <p className="cl-inbox-pad">Loading notifications…</p>;
  if (status === "failed")
    return (
      <div className="cl-inbox-pad">
        <StateNote tone="error" action={{ label: "Retry", onClick: () => void load() }}>
          Notifications could not be loaded. Nothing has changed.
        </StateNote>
      </div>
    );
  return (
    <div className="cl-inbox">
      <div className="cl-inbox-head">
        <span className="cl-inbox-count">{state.unread > 0 ? `${state.unread} unread` : "All read"}</span>
        <Button variant="ghost" size="sm"  onClick={() => void readAll()} disabled={state.unread === 0 || busy === "all"}>
          Mark all read
        </Button>
      </div>
      {note && (
        <div role="alert" className="cl-inbox-pad">
          <StateNote tone="error">{note}</StateNote>
        </div>
      )}
      {state.items.length === 0 ? (
        <p className="cl-inbox-pad">Nothing here yet. Replies, invitations and moderation notices land here.</p>
      ) : (
        <ul className="cl-inbox-list">
          {state.items.map((n) => (
            <li key={n.id}>
              <button type="button" className={`cl-inbox-row${n.read_at ? "" : " cl-inbox-row--unread"}`} onClick={() => void open(n)}>
                <span className="cl-inbox-title">{titleOf(n)}</span>
                {typeof n.payload.body === "string" && n.payload.body ? <span className="cl-inbox-body">{n.payload.body}</span> : null}
                <span className="cl-inbox-time"><RelativeTime iso={n.created_at} /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state.next && (
        <div className="cl-inbox-pad">
          <Button  onClick={() => void older()} disabled={busy === "older"}>
            {busy === "older" ? "Loading…" : "Load older"}
          </Button>
        </div>
      )}
    </div>
  );
}
