// Ported from old_repo/src/lib/supabase-browser.ts (lines 1-8)
import { createBrowserClient } from "@supabase/ssr";

import type { Db } from "./clients";
import { cookieOptions } from "./cookie-options";

/** Browser client: the anon key and the visitor's own session. Client components import this file, never clients.ts. */
export function browserClient(): Db {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase is not configured: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
  return createBrowserClient(url, anon, { cookieOptions: cookieOptions() }) as unknown as Db;
}
