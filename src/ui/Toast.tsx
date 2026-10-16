"use client";

// Ported from old_repo/src/components/ui/Toast.tsx (lines 7-62)
import { useEffect, useRef, useState } from "react";

/** Auto-dismissing toast. The timer is keyed on `visible` only (an inline onDismiss arrow cannot re-arm it: B-1966); the exit timeout is cleared; the box has a max-width (B-1967). */
export function Toast({ message, visible, onDismiss, duration = 3000, variant = "success" }: { message: string; visible: boolean; onDismiss: () => void; duration?: number; variant?: "success" | "error" }) {
  const [show, setShow] = useState(false);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });
  useEffect(() => {
    if (!visible) return;
    const enter = setTimeout(() => setShow(true), 0);
    let exit: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      setShow(false);
      exit = setTimeout(() => dismiss.current(), 300);
    }, duration);
    return () => {
      clearTimeout(enter);
      clearTimeout(timer);
      clearTimeout(exit);
    };
  }, [visible, duration]);
  if (!visible) return null;
  return (
    <div role={variant === "error" ? "alert" : "status"} className={`cl-toast cl-toast--${variant}${show ? " cl-toast--in" : ""}`}>
      <span aria-hidden="true">{variant === "success" ? "✓" : "×"}</span>
      {message}
    </div>
  );
}
