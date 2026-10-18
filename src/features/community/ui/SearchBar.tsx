"use client";

// Ported from old_repo/src/components/community/CommunitySearchBar.tsx (lines 39-188)
// The Community search: a query, four scopes (all, posts, groups, people) as 44 px segments, and Cmd or Ctrl+K to focus it. It is scoped to Community content, so it is its own control and not the platform's command bar.
import { useEffect, useRef, useState } from "react";

import { Button, Input, Segmented } from "@/ui";

import { LIMITS } from "../lib/labels";

import styles from "./community.module.css";

export type SearchScope = "all" | "posts" | "groups" | "people";
const SCOPES = [
  { id: "all", label: "All" },
  { id: "posts", label: "Posts" },
  { id: "groups", label: "Groups" },
  { id: "people", label: "People" },
] as const;

export function SearchBar({ onSubmit }: { onSubmit: (query: string, scope: SearchScope) => void }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <form
      role="search"
      aria-label="Search Community"
      className={styles.searchForm}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(query, scope);
      }}
    >
      <Input ref={input} type="search" aria-label="Search posts, groups and people" placeholder="Search posts, groups and people" maxLength={LIMITS.search} value={query} onChange={(e) => setQuery(e.target.value)} />
      <Segmented label="Search scope" options={SCOPES} selected={[scope]} onSelect={setScope} />
      <Button type="submit" variant="primary">
        Search
      </Button>
    </form>
  );
}
