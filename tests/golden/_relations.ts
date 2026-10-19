import type { GoldenRow } from "@/core/golden/load";

type Q = GoldenRow["inputs"][number];
const decimals = (v: string): number => (v.includes(".") ? (v.split(".")[1] ?? "").length : 0);
/** Half a unit of the last published digit, for a printed figure the row marks as rounded or truncated; every other value is exact. */
const half = (q: Q): number => (q.rounded && q.value !== undefined ? 0.5 * 10 ** -decimals(q.value) : 0);
const EPS = 1e-9;

function span(q: Q | undefined): [number, number] | null {
  if (!q || q.value === undefined) return null;
  const v = Number(q.value);
  return [v - half(q), v + half(q)];
}
const meets = (a: [number, number], b: [number, number]): boolean => a[0] <= b[1] + EPS * Math.max(1, Math.abs(b[1])) && b[0] <= a[1] + EPS * Math.max(1, Math.abs(a[1]));

/**
 * The arithmetic the row states, checked on its expected values. A recomputation meets the printed figure within half a unit of the
 * last published digit of each rounded operand (never exactly); a WTT + TTW = WTW triple holds within the last digit or the row carries
 * `source_unit_defect` (INV-R6a-3). Returns one line per violated relation.
 */
export function relationProblems(row: GoldenRow): string[] {
  const by = new Map<string, Q>([...row.inputs, ...row.outputs].map((q) => [q.name, q]));
  const out: string[] = [];
  for (const rel of row.relations) {
    const get = (n: string): [number, number] | null => span(by.get(n));
    const label = `${row.id} ${rel.type}`;
    let lhs: [number, number] | null = null;
    let rhs: [number, number] | null = null;
    if (rel.type === "wtw") {
      const [a, b, c] = [rel.wtt, rel.ttw, rel.wtw].map((n) => by.get(n));
      if (!a?.value || !b?.value || !c?.value) { out.push(`${label}: operand missing or not a number`); continue; }
      const ulp = 10 ** -Math.max(decimals(a.value), decimals(b.value), decimals(c.value));
      if (Math.abs(Number(a.value) + Number(b.value) - Number(c.value)) > ulp * (1 + EPS) && !row.flags.includes("source_unit_defect")) out.push(`${label}: ${a.value} + ${b.value} is not ${c.value} within the last digit`);
      continue;
    }
    if (rel.type === "sum") {
      const parts = rel.terms.map(get);
      if (parts.some((p) => !p)) { out.push(`${label}: operand missing or not a number`); continue; }
      lhs = [parts.reduce((s, p) => s + p![0], 0), parts.reduce((s, p) => s + p![1], 0)];
      rhs = get(rel.total);
    } else if (rel.type === "product") {
      const parts = rel.factors.map(get);
      if (parts.some((p) => !p)) { out.push(`${label}: operand missing or not a number`); continue; }
      const k = rel.scale ?? 1;
      lhs = [parts.reduce((s, p) => s * p![0], k), parts.reduce((s, p) => s * p![1], k)];
      rhs = get(rel.result);
    } else {
      const n = get(rel.numerator);
      const d = get(rel.denominator);
      if (!n || !d || d[0] <= 0) { out.push(`${label}: operand missing or not a positive number`); continue; }
      lhs = [n[0] / d[1], n[1] / d[0]];
      rhs = get(rel.result);
    }
    if (!lhs || !rhs) out.push(`${label}: result missing or not a number`);
    else if (!meets(lhs, rhs)) out.push(`${label}: recomputed [${lhs[0]}, ${lhs[1]}] does not meet printed [${rhs[0]}, ${rhs[1]}]`);
  }
  return out;
}
