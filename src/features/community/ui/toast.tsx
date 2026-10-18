"use client";

// Ported from old_repo/src/components/community/PostList.tsx (lines 312-335)
// Ported from old_repo/src/components/community/CommunityShell.tsx (lines 100-120)
// The one Toast for Community. The old tree had three toasts and two components that took an OPTIONAL toast callback nobody passed (the group header and the moderation queue), so a failed star, mute or
// moderation action said nothing. Here the callback is not a prop: a part calls useToast(), which throws outside a provider, so a missing toast is a crash in development and a test, never a silent failure.
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

import { Toast } from "@/ui";

export type Notify = (message: string, variant?: "success" | "error") => void;
const ToastContext = createContext<Notify | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; variant: "success" | "error"; visible: boolean }>({ message: "", variant: "success", visible: false });
  const notify = useCallback<Notify>((message, variant = "success") => setToast({ message, variant, visible: true }), []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <Toast message={toast.message} variant={toast.variant} visible={toast.visible} onDismiss={() => setToast((t) => ({ ...t, visible: false }))} />
    </ToastContext.Provider>
  );
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast was called outside a ToastProvider: every Community page mounts one in its layout");
  return notify;
}
