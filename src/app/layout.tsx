// Ported from old_repo/src/app/layout.tsx (lines 1-76)
import "@fontsource/plus-jakarta-sans/400.css";
import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/700.css";
import "@fontsource/plus-jakarta-sans/800.css";
import "@fontsource/anton/400.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "@/ui/theme.css";
import "@/ui/base.css";
import { AskAssistant } from "@/features/assistant/ui/AskAssistant";
import { Providers } from "@/ui/shell/Providers";

export const metadata: Metadata = {
  title: "Caro's Ledge — Freight Sustainability Intelligence",
  description: "Sustainability intelligence platform for international freight forwarding. Monitors regulatory, technology, and market developments across air, road, and ocean transport.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// No dynamic API anywhere in the root layout (ADR-026): every page stays statically cacheable; per-user state arrives after first paint (Providers).
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="light">
      <body>
        <Providers assistant={<AskAssistant />}>{children}</Providers>
      </body>
    </html>
  );
}
