// Ported from old_repo/src/app/admin/items/[id]/page.tsx (lines 16-32)
import Link from "next/link";

import { ItemCorrectionsPanel } from "../corrections/ItemCorrectionsPanel";
import type { ItemTargets } from "../corrections/types";

import styles from "./admin.module.css";

/** The single-pane corrections screen for one item: where an admin overrides a machine value. */
export function ItemCorrectionsPage({ targets }: { targets: ItemTargets }) {
  return (
    <main className={styles.single}>
      <Link href="/admin" className={styles.link}>Back to the admin dashboard</Link>
      <ItemCorrectionsPanel targets={targets} />
    </main>
  );
}
