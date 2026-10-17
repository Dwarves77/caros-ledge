"use client";

// Ported from old_repo/src/components/research/ResearchThemeCards.tsx (lines 42-151)
import { THEME_DESCRIPTIONS, themeLabel, UNCLASSIFIED_LABEL } from "../model/taxonomy";
import { UNCLASSIFIED } from "../theme-rules";

import styles from "./research.module.css";

export interface ThemePill {
  key: string;
  count: number;
  /** Items added inside the "new" window; 0 draws nothing. */
  newCount: number;
}

/**
 * The theme facet row (artboard 06: themes are a second facet row, not a second tile system): one pill per theme present in the current selection with its live count and "+N new", then the
 * Unclassified pill whenever a verified finding matched no theme (an honest band, never silently dropped). Every pill is 44 px tall; the description rides on the title and, for touch, is not the only home of the label.
 */
export function ThemeFacetRow({ themes, selected, onSelect, unclassifiedCount }: { themes: ThemePill[]; selected: string | null; onSelect: (key: string | null) => void; unclassifiedCount: number }) {
  if (themes.length === 0 && unclassifiedCount <= 0) return null;
  const pill = (key: string, label: string, count: number, newCount: number, title: string | undefined, dashed: boolean) => {
    const on = selected === key;
    return (
      <button key={key} type="button" aria-pressed={on} title={title} onClick={() => onSelect(on ? null : key)} className={`${styles.pill}${on ? ` ${styles.pillOn}` : ""}${dashed ? ` ${styles.pillDashed}` : ""}`}>
        <span className={styles.pillLabel}>{label}</span>
        <span className={styles.pillCount}>
          {count}
          {newCount > 0 && <span className={styles.pillNew}> +{newCount} new</span>}
        </span>
      </button>
    );
  };
  return (
    <div data-audit="theme-cards" data-part="theme-facet-row" className={styles.pills}>
      {themes.map((t) => pill(t.key, themeLabel(t.key), t.count, t.newCount, THEME_DESCRIPTIONS[t.key], false))}
      {unclassifiedCount > 0 && pill(UNCLASSIFIED, UNCLASSIFIED_LABEL, unclassifiedCount, 0, "Verified findings whose text matched none of the seven research themes.", true)}
    </div>
  );
}
