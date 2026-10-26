// New in VALID-1: R6 (V11): each stored entry_into_force and compliance_deadline is written in the body in one of the accepted renderings (data/date-renderings.json).
import { z } from "zod";

import datesJson from "../data/date-renderings.json";

import { violation } from "./_text";
import type { Rule } from "./types";

const D = z.object({ register: z.array(z.string()), extra: z.array(z.string()) }).strict().parse(datesJson);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const suffix = (d: number): string => (d % 100 >= 11 && d % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][d % 10] ?? "th"));
/** One ISO date (YYYY-MM-DD) in one rendering template. */
function render(iso: string, template: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  const parts: Record<string, string> = { D: String(d), DD: String(d).padStart(2, "0"), MM: String(m).padStart(2, "0"), Month: MONTHS[m - 1] ?? "", Mon: (MONTHS[m - 1] ?? "").slice(0, 3), YYYY: String(y), ord: suffix(d) };
  return template.replace(/\{(\w+)\}/g, (_, k: string) => parts[k] ?? "");
}
export const REGISTER_RENDERINGS: readonly string[] = D.register;
export const stated = (body: string, iso: string, templates: readonly string[] = [...D.register, ...D.extra]): boolean => templates.some((t) => body.toLowerCase().includes(render(iso, t).toLowerCase()));

const rule: Rule = (b, i) => {
  const missing = (["entry_into_force", "compliance_deadline"] as const).filter((k) => i[k] && !stated(b.body, i[k] as string));
  return missing.length ? violation("stored-date-stated", missing.map((k) => `${k} ${String(i[k])} is never written in the body`).join("; "), "") : null;
};
export default rule;
