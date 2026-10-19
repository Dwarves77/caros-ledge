"use client";

// Ported from old_repo/src/components/AppShell.tsx (lines 31-266)
// Ported from old_repo/src/components/app-shell-banner.ts (lines 1-46)
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { bandOf } from "@/core/lists";
import { useAuth } from "@/features/auth/ui/AuthProvider";

import { StateNote } from "../StateNote";

import { BackToTop } from "./BackToTop";
import { AssistantProvider } from "./CommandBar";
import { Hydrated } from "./Hydrated";
import { shellNotes } from "./identity-seed";
import { isChromeless } from "./nav-model";
import { NavCard } from "./NavCard";
import { NotificationsBell } from "./notifications";
import { ScrollContainer, ScrollProvider } from "./scroll-container";
import { Sheet } from "./Sheet";
import { useSurfaceNav } from "./surface-nav";
import { TopBar } from "./TopBar";
import { useBootstrap } from "./use-bootstrap";

/**
 * The frame: the 252 px nav card and the content column on desktop; the top bar and a drawer on the phone. Auth, onboarding, invitation and privacy pages render
 * WITHOUT the signed-in chrome and without its requests (an anonymous /privacy issues no bootstrap, notifications or admin call). The notes: a failed identity
 * lookup is an error note with Retry; "No workspace yet" is said only on a resolved null, and sends a resolved no-membership user to onboarding.
 * `assistant` is a slot for the assistant surface; the command bar draws Ask only when one is mounted.
 */
export function AppShell({ children, assistant }: { children: ReactNode; assistant?: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, orgId, identityStatus, retryingIdentity, retryIdentity } = useAuth();
  const chromeless = isChromeless(pathname);
  const surfaceNav = useSurfaceNav();
  const [drawer, setDrawer] = useState(false);
  const [drawerPath, setDrawerPath] = useState(pathname);
  if (drawerPath !== pathname) {
    setDrawerPath(pathname);
    if (drawer) setDrawer(false);
  }
  const bootstrap = useBootstrap(!chromeless && user ? user.id : null);
  const notes = shellNotes({ user, orgId, identityStatus, pathname });
  useEffect(() => {
    if (notes.redirect) router.replace(notes.redirect);
  }, [notes.redirect, router]);

  if (chromeless) return <><Hydrated />{children}</>;
  return (
    <ScrollProvider>
      <Hydrated />
      <div className="cl-shell-desk">
        <div className="cl-app-frame">
          {surfaceNav ? surfaceNav({ variant: "card" }) : <NavCard />}
          <div className="cl-shell-col">
            {user && <NotificationsBell />}
            <TopBar onMenuClick={() => setDrawer(true)} />
            {notes.noWorkspace && (
              <div role="status" className="cl-shell-banner">
                <span>
                  <b>No workspace yet.</b> Accept an invitation or create your own to start collaborating.
                </span>
                <Link href="/workspace/new" className="cl-shell-banner-link">
                  Set up workspace
                </Link>
              </div>
            )}
            {notes.identityError && (
              <div role="status" aria-live="polite" className="cl-shell-note">
                <StateNote band={bandOf("immediate")} action={{ label: retryingIdentity ? "Retrying…" : "Retry", onClick: retryingIdentity ? () => {} : retryIdentity }}>
                  We couldn&rsquo;t load your workspace and role just now. Nothing in your account has changed. Retry, or it will try again when you return to this tab.
                </StateNote>
              </div>
            )}
            {bootstrap.status === "failed" && (
              <div role="status" aria-live="polite" className="cl-shell-note">
                <StateNote tone="error" action={{ label: "Retry", onClick: bootstrap.refresh }}>
                  We couldn&rsquo;t load your saved items and team just now. Nothing has changed. Retry to load them again.
                </StateNote>
              </div>
            )}
            <ScrollContainer>
              <AssistantProvider mounted={!!assistant}>{children}</AssistantProvider>
            </ScrollContainer>
          </div>
        </div>
        <Sheet open={drawer} onClose={() => setDrawer(false)} title="Navigation" side="left" hideTitle>
          {surfaceNav ? surfaceNav({ variant: "drawer", onNavigate: () => setDrawer(false) }) : <NavCard variant="drawer" onNavigate={() => setDrawer(false)} />}
        </Sheet>
        {assistant}
        <BackToTop />
      </div>
    </ScrollProvider>
  );
}
