"use client";

// Ported from old_repo/src/components/community/CommunityShell.tsx (lines 64-203)
// The Community sub-page frame: the sidebar through the shell's surface-nav slot (no injected style, a drawer on the phone), the masthead with the server's date, the scoped search, the region tabs where they filter,
// the search results in place of the page while a search is open, and ONE Toast for everything inside. The masthead date is the request's instant, never a clock read in render.
import { useCallback, useState, type ReactNode } from "react";

import { Masthead } from "@/ui";
import { PageFrame, SurfaceNav, type SurfaceNavRender } from "@/ui/shell";

import type { ShellContext } from "../lib/shell-context";

import styles from "./community.module.css";
import { RegionTabs } from "./RegionTabs";
import { SearchBar, type SearchScope } from "./SearchBar";
import { SearchResults } from "./SearchResults";
import { CommunitySidebar } from "./Sidebar";
import { ToastProvider, useToast } from "./toast";

interface LayoutProps {
  shell: ShellContext;
  nowIso: string;
  dateLabel: string;
  /** The region the tabs mark; the tabs are drawn only where a page filters by region. */
  region?: string;
  children: ReactNode;
}

function Body({ shell, nowIso, dateLabel, region, children }: LayoutProps) {
  const notify = useToast();
  const [search, setSearch] = useState<{ query: string; scope: SearchScope } | null>(null);
  return (
    <PageFrame>
      <div className={styles.stack}>
        <Masthead title="Community" dateLabel={dateLabel} nowIso={nowIso} dek="Regional working groups, public forums, connect with peers across the industry" />
        <SearchBar
          onSubmit={(query, scope) => {
            if (query.trim().length < 2) return notify("Type at least 2 characters to search", "error");
            setSearch({ query: query.trim(), scope });
          }}
        />
        {region !== undefined && <RegionTabs counts={shell.regionCounts} active={region} />}
        {search ? <SearchResults query={search.query} scope={search.scope} onClose={() => setSearch(null)} /> : children}
      </div>
    </PageFrame>
  );
}

export function CommunityLayout(props: LayoutProps) {
  const render = useCallback<SurfaceNavRender>(({ variant, onNavigate }) => <CommunitySidebar shell={props.shell} variant={variant} onNavigate={onNavigate} />, [props.shell]);
  return (
    <ToastProvider>
      <SurfaceNav render={render} />
      <Body {...props} />
    </ToastProvider>
  );
}
