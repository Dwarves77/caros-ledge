"use client";

// Ported from old_repo/src/components/BackToTop.tsx (lines 1-33)
import { useEffect, useState } from "react";

import { useScrollContainer } from "./scroll-container";

const BACK_TO_TOP_AFTER_PX = 400;

/** Jump to the top after 400 px of scroll in <main>, the box the page really scrolls in (the old button listened to the window and never showed: B-0658). A 44 px target. */
export function BackToTop() {
  const box = useScrollContainer();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const target: HTMLElement | Window = box ?? window;
    const top = () => (box ? box.scrollTop : window.scrollY);
    const onScroll = () => setShow(top() > BACK_TO_TOP_AFTER_PX);
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [box]);
  return (
    <button type="button" aria-label="Back to top" tabIndex={show ? 0 : -1} className={`cl-back-to-top${show ? " cl-back-to-top--on" : ""}`} onClick={() => (box ?? window).scrollTo({ top: 0, behavior: "smooth" })}>
      <span aria-hidden="true">↑</span>
    </button>
  );
}
