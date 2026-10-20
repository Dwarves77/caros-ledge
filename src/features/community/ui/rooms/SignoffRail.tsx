"use client";

// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 1198-1359)
// Ported from old_repo/src/components/community/CommunityRooms.tsx (lines 1362-1389)
// The verifier sign-off rail: what sign-off is, whether you are a verifier (one meaning of "verified" here: an active verifier; the email-verified mark is another thing and is not this), your open requests with Withdraw,
// and for an active verifier the decide queue with Sign off (which needs the address of the primary document it was checked against, and records it) and Decline. The copy states what a sign-off does inside Community and no more (it does not say a signed-off claim becomes citable elsewhere).
import Link from "next/link";
import { useState } from "react";

import { Button, FormField, Input, SectionCard } from "@/ui";

import type { ThreadVM } from "../../lib/rooms-view";
import styles from "../community.module.css";

export function SignoffRail({ threads, isVerifier, verifierStatus, busy, onWithdraw, onDecide }: { threads: ThreadVM[]; isVerifier: boolean; verifierStatus: string; busy: boolean; onWithdraw: (t: ThreadVM) => void; onDecide: (t: ThreadVM, decision: "signed_off" | "declined", docUrl?: string) => void }) {
  const [docs, setDocs] = useState<Record<string, string>>({});
  const mine = threads.filter((t) => t.signoff?.isMine && t.signoff.status === "pending");
  const queue = threads.filter((t) => t.signoff?.status === "pending");
  return (
    <SectionCard dataAudit="verifier-signoff">
      <div className={styles.railPad}>
        <p className={styles.eyebrow}>Verifier sign-off</p>
        <p className={styles.muted}>
          A verifier checks a post&rsquo;s claim against a primary document and marks it signed off in the room.{" "}
          {isVerifier ? (
            <>
              You are an <b>active verifier</b>.
            </>
          ) : verifierStatus === "pending" ? (
            <>Your verifier application is in review.</>
          ) : (
            <>
              You are <Link href="/profile" className={styles.inlineLink}>not a verifier</Link>.
            </>
          )}
        </p>
        {mine.length === 0 ? (
          <p className={styles.muted}>
            Your open requests · <span className={styles.absent}>none</span>
          </p>
        ) : (
          <>
            <p className={styles.eyebrow}>Your open requests</p>
            {mine.map((t) => (
              <div key={t.id} className={styles.personRow}>
                <a href={`#post-${t.id}`} className={`${styles.grow} ${styles.railLink}`}>
                  {t.title.slice(0, 60)}
                </a>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => onWithdraw(t)}>
                  Withdraw
                </Button>
              </div>
            ))}
          </>
        )}
        {isVerifier && (
          <div className={styles.decideQueue}>
            <p className={styles.eyebrow}>Decide queue</p>
            {queue.length === 0 && <p className={styles.muted}>No sign-off requests waiting in this room.</p>}
            {queue.map((t) => (
              <div key={t.id} className={styles.stackTight}>
                <a href={`#post-${t.id}`} className={styles.railLink}>{t.title.slice(0, 70)}</a>
                <p className={styles.muted}>Requested by {t.signoff?.requesterName}</p>
                <FormField label="Primary document address" hint="A sign-off names what it was checked against.">{(c) => <Input {...c} type="url" value={docs[t.id] ?? ""} onChange={(e) => setDocs({ ...docs, [t.id]: e.target.value })} placeholder="https://" />}</FormField>
                <div className={styles.actions}>
                  <Button variant="primary" size="sm" disabled={busy || !/^https?:\/\/\S+$/.test((docs[t.id] ?? "").trim())} onClick={() => onDecide(t, "signed_off", (docs[t.id] ?? "").trim())}>
                    Sign off
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide(t, "declined")}>
                    Decline
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
