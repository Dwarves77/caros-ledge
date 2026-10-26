"use client";

// The meta line of a list row (ROWS-1 R3): one line. When it does not fit, the chips marked `data-drop` are set aside whole, lowest rank first, and a count says how many ("+1"); the date and the tier are never marked, so they stay.
import { useLayoutEffect, useRef, type ReactNode } from "react";

export function RowMeta({ children }: { children: ReactNode }) {
  const line = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = line.current;
    if (!el) return;
    const fit = () => {
      const chips = [...el.querySelectorAll<HTMLElement>("[data-drop]")].sort((a, b) => Number(a.dataset.drop) - Number(b.dataset.drop));
      const more = el.querySelector<HTMLElement>("[data-more]");
      if (!more) return;
      for (const c of chips) c.hidden = false;
      more.hidden = true;
      let n = 0;
      while (el.scrollWidth > el.clientWidth + 1 && n < chips.length) {
        chips[n++]!.hidden = true;
        more.hidden = false;
        more.textContent = `+${n}`;
      }
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [children]);
  return (
    <div ref={line} className="cl-row-meta">
      {children}
      <span data-more="" hidden className="cl-row-more" />
    </div>
  );
}
