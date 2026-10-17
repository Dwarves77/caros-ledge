"use client";

// Ported from old_repo/src/components/sources/SourceAdminControls.tsx (lines 14-217)
import { useState } from "react";

import { Button, FormField, Input, Select, StateNote } from "@/ui";
import { Load, useAct, useAdminFetch, useFlash } from "@/features/admin/ui/panel-kit";
import styles from "@/features/admin/ui/admin.module.css";

interface Hold {
  paused: boolean;
  cadence: "off" | "weekly" | "monthly";
  start_date: string | null;
  next_scrape: string | null;
}

/** What the strip says about the hold: while the cadence is off nothing scrapes, not the automated worker and not a manual fetch; the emergency stop halts everything and keeps the saved schedule. Pure. */
export function holdSentence(h: Hold): string {
  if (h.paused) return `Emergency stop engaged. Nothing scrapes. Saved schedule: ${h.cadence === "off" ? "off" : `${h.cadence} from ${h.start_date}`} (kept).`;
  if (h.cadence === "off") return "Scraping is off. Nothing scrapes, not the automated worker and not a manual fetch. Set a cadence to turn it on.";
  return `Scraping ${h.cadence} from ${h.start_date}. Next run: ${h.next_scrape ?? "not scheduled"}.`;
}

/** The scrape schedule and the emergency stop (the hold switch; the pause flags have one writer, the route's rpc). A failed read is a failure with Retry, never a strip that is simply absent. */
export function ScrapeScheduleStrip() {
  const q = useAdminFetch<Hold>("/api/admin/sources/pause-global");
  const flash = useFlash();
  const act = useAct(flash, q.reload);
  const [cadence, setCadence] = useState<Hold["cadence"] | null>(null);
  const [start, setStart] = useState<string | null>(null);
  return (
    <div data-audit="registry-scrape-strip" className={styles.stack}>
      <Load q={q} what="The scrape schedule">
        {(h) => {
          const c = cadence ?? h.cadence;
          const s = start ?? h.start_date ?? "";
          return (
            <>
              <StateNote>{holdSentence(h)}</StateNote>
              <div className={styles.actions}>
                <FormField label="Cadence">{(f) => <Select {...f} value={c} onChange={(e) => setCadence(e.target.value as Hold["cadence"])}><option value="off">Not at all (off)</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select>}</FormField>
                {c !== "off" ? <FormField label={c === "weekly" ? "Start (weekday)" : "Start (day of month)"}>{(f) => <Input {...f} type="date" value={s} onChange={(e) => setStart(e.target.value)} />}</FormField> : null}
                <Button variant="primary" disabled={act.busy !== null} onClick={() => act.run("save", "/api/admin/sources/pause-global", { method: "POST", body: { cadence: c, ...(c !== "off" && s ? { start_date: s } : {}) } }, c === "off" ? "Scraping set to off." : `Scraping ${c}.`)}>Save</Button>
                <Button variant="secondary" aria-pressed={h.paused} disabled={act.busy !== null} onClick={() => act.run("stop", "/api/admin/sources/pause-global", { method: "POST", body: { paused: !h.paused } }, h.paused ? "Emergency stop released." : "Emergency stop engaged. The saved schedule is kept.")}>{h.paused ? "Release emergency stop" : "Emergency stop"}</Button>
              </div>
            </>
          );
        }}
      </Load>
      {flash.node}
    </div>
  );
}
