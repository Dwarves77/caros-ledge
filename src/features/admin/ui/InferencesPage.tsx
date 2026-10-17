// Ported from old_repo/src/app/admin/inferences/page.tsx (lines 10-71)
import { formatLocaleDate } from "@/core/shared";
import { Masthead, StateNote } from "@/ui";

import { InferenceReview } from "./RuntimeViews";
import styles from "./admin.module.css";

type Rows = Parameters<typeof InferenceReview>[0]["rows"];

/** The learning loop's current inferences, read-only: the claim, its status token, confidence and cited items. A failed read says so; it is never an empty list. */
export function InferencesPage({ data, error, nowIso }: { data: { rows: Rows; itemTitles: Record<string, string> } | null; error: string | null; nowIso: string }) {
  return (
    <>
      <div className={styles.head}>
        <Masthead title="Inferences" size="list" dateLabel={formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} nowIso={nowIso} eyebrowSuffix="Platform admin · learning loop" dek={data ? `${data.rows.length} current inference${data.rows.length === 1 ? "" : "s"} · read-only` : "The inferences could not be read."} />
      </div>
      <div className={styles.single}>{data ? <InferenceReview rows={data.rows} itemTitles={data.itemTitles} /> : <StateNote tone="error">The inferences did not load: {error ?? "no answer"}.</StateNote>}</div>
    </>
  );
}
