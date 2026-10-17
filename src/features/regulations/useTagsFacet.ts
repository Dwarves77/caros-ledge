"use client";

// Ported from old_repo/src/lib/tags/useWorkspaceTagsFacet.ts (lines 1-103)
// The workspace-tags facet of a list: the workspace's tags with live counts, the one selected, and the tags of each row. One call to /api/workspace/tags?withItemTags=1; a failure is a state the
// list says (the facet is left out and a note offers Retry), never an empty tag list.
import { useCallback, useEffect, useMemo, useState } from "react";

import { requestJson } from "@/core/http/request-json";

interface Tag {
  id: string;
  name: string;
  itemCount: number;
}
export function useTagsFacet() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [byItem, setByItem] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ tags?: Tag[]; itemTags?: Record<string, string[]> }>("/api/workspace/tags?withItemTags=1").then((r) => {
      if (cancelled) return;
      setFailed(!r.ok);
      if (r.ok && r.data) {
        setTags(r.data.tags ?? []);
        setByItem(r.data.itemTags ?? {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const byId = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const matches = useCallback((itemId: string) => selected === null || (byItem[itemId] ?? []).includes(selected), [selected, byItem]);
  const tagsFor = useCallback((itemId: string) => (byItem[itemId] ?? []).flatMap((id) => (byId.has(id) ? [{ id, name: (byId.get(id) as Tag).name }] : [])), [byItem, byId]);
  return { tags, selected, setSelected, matches, tagsFor, failed, retry: () => setAttempt((n) => n + 1) };
}
