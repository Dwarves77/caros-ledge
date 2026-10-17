// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 175-299)
// The two classifications the market detail page shows beside a signal: the five-label signal kind and the three-way corporate band. The stored column wins; the keyword pass is the fallback the old page had.
import type { Resource } from "@/core/types";

export type Severity = "action" | "cost" | "window" | "edge" | "monitor";
export type BandKey = "price" | "corporate" | "corridor";

export const SEVERITY_LABEL: Record<Severity, string> = { action: "Action required", cost: "Cost alert", window: "Window closing", edge: "Competitive edge", monitor: "Monitoring" };
export const BAND_LABEL: Record<BandKey, string> = { price: "Price signals", corporate: "Corporate & capital", corridor: "Corridors & routes" };
export const BAND_NUM: Record<BandKey, number> = { price: 1, corporate: 2, corridor: 3 };

const COLUMN_TO_KEY: Record<string, Severity> = { action_required: "action", cost_alert: "cost", window_closing: "window", competitive_edge: "edge", monitoring: "monitor" };
const SEVERITY_KEYWORDS: Record<Severity, RegExp[]> = {
  action: [/\baction required\b/i, /\bimmediate\b/i, /\bdeadline\b/i, /\bmust file\b/i],
  cost: [/\b(cost|surcharge|pass[- ]?through|margin|price.*(rise|up|breach))\b/i, /\bcost alert\b/i],
  window: [/\b(window|deadline|by 20|q\d \d{4}|enforcement|consultation)\b/i],
  edge: [/\b(competitive|edge|advantage|lock(ed)?|offtake|partnership)\b/i],
  monitor: [/\b(monitor|tracking|watch|observe)\b/i],
};
const BAND_KEYWORDS: Record<BandKey, RegExp[]> = {
  price: [/\b(price|spot|futures|tariff|surcharge|fuel|saf|eua|carbon|crude|jet a-?1|diesel)\b/i, /eur ?\d|usd ?\d|gbp ?\d|aed ?\d/i, /\/t\b|\/kwh|\/teu|\/l\b/i],
  corporate: [/\b(announces|raises|acquires|merger|partner|deploy|capacity|fleet|order|supplier|offtake|m&a)\b/i],
  corridor: [/\b(corridor|route|chokepoint|port|hormuz|suez|canal|cape|drayage|lane)\b/i, /\b(eu ?[→-]? ?(us|asia)|us ?[→-]? ?(eu|asia))\b/i],
};

type Classifiable = Pick<Resource, "title" | "note" | "priority"> & { severity?: string | null | undefined; signalBand?: string | null | undefined };

export function deriveSeverity(r: Classifiable): Severity {
  const column = r.severity ? COLUMN_TO_KEY[r.severity] : undefined;
  if (column) return column;
  const text = `${r.title} ${r.note || ""}`;
  for (const sev of ["action", "cost", "window", "edge", "monitor"] as const) if (SEVERITY_KEYWORDS[sev].some((re) => re.test(text))) return sev;
  return r.priority === "CRITICAL" ? "action" : r.priority === "HIGH" ? "cost" : r.priority === "MODERATE" ? "window" : "monitor";
}

export function assignBand(r: Classifiable): BandKey {
  if (r.signalBand === "price" || r.signalBand === "corporate" || r.signalBand === "corridor") return r.signalBand;
  const text = `${r.title} ${r.note || ""}`;
  for (const band of ["price", "corporate", "corridor"] as const) if (BAND_KEYWORDS[band].some((re) => re.test(text))) return band;
  return "corporate";
}
