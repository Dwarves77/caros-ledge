// Ported from old_repo/src/lib/sources/api-transport.mjs (lines 1-96)
// Ported from old_repo/src/lib/sources/transport-escalation.mjs (lines 98-125)
import { hostOf } from "@/core/shared";

export const FEDERAL_REGISTER_API_BASE = "https://www.federalregister.gov/api/v1";
export const FEDERAL_REGISTER_PORTAL_URL = "https://www.federalregister.gov";
const ECFR_API_BASE = "https://www.ecfr.gov/api";
export const ECFR_PORTAL_URL = "https://www.ecfr.gov";

/** The official JSON API base for a host, or null when the host has no API transport. */
export function apiEndpointFor(url: string): string | null {
  const h = hostOf(url);
  if (/(^|\.)federalregister\.gov$/.test(h)) return FEDERAL_REGISTER_API_BASE;
  if (/(^|\.)ecfr\.gov$/.test(h)) return ECFR_API_BASE;
  return null;
}

