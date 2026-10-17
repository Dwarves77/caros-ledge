"use client";

// Ported from old_repo/src/components/detail/DetailShell.tsx (lines 69-92, 499-531)
// The one reader of the list-return contract a list row puts on a detail href: the list, the position, the total and the neighbours (list=, pos=, of=, prev=, next=). The old shell read the
// same query string in three places.
import { useSearchParams } from "next/navigation";

import { withListPosition } from "../list-surface/filter-sort";

export interface ListPosition {
  list: string | null;
  pos: number | null;
  of: number | null;
  /** True when both the position and the total are real numbers. */
  known: boolean;
  prev: string | null;
  next: string | null;
}

const num = (v: string | null): number | null => (v !== null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export function useListPosition(): ListPosition {
  const q = useSearchParams();
  const pos = num(q.get("pos"));
  const of = num(q.get("of"));
  return { list: q.get("list"), pos, of, known: pos !== null && of !== null, prev: q.get("prev"), next: q.get("next") };
}

/** The href of the previous or next row of the list, carrying the list position forward; null when there is no such neighbour. */
export function neighbourHref(basePath: string, position: ListPosition, direction: -1 | 1): string | null {
  const id = direction < 0 ? position.prev : position.next;
  if (!position.known || !id || position.pos === null || position.of === null) return null;
  return withListPosition(`${basePath}/${encodeURIComponent(id)}`, position.list ?? "", position.pos + direction, position.of);
}
