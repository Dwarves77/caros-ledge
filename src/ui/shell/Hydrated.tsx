"use client";

import { useEffect } from "react";

/** Marks the document `data-hydrated="true"` once the shell has hydrated. The UX smokes and the parity capture wait for it instead of sleeping, so a script never measures or clicks server markup that has no handlers yet. */
export function Hydrated() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
