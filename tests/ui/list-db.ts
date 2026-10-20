// A scripted stand-in for the Supabase client rpc and select chains, for the list reads. Records every call.
type Reply = { data?: unknown; error?: { message: string } | null; count?: number | null };
export interface Call {
  kind: "rpc" | "from";
  name: string;
  args?: unknown;
  range?: [number, number];
  filters: Array<[string, unknown]>;
}

export function listDb(script: { rpc?: (name: string, args: Record<string, unknown>, range: [number, number] | null) => Reply; from?: (table: string, filters: Array<[string, unknown]>) => Reply }) {
  const calls: Call[] = [];
  const settle = (r: Reply) => ({ data: r.data ?? null, error: r.error ?? null, count: r.count ?? null });
  const db = {
    rpc(name: string, args: Record<string, unknown> = {}) {
      const call: Call = { kind: "rpc", name, args, filters: [] };
      calls.push(call);
      const run = (range: [number, number] | null) => Promise.resolve(settle(script.rpc?.(name, args, range) ?? { data: [] }));
      return {
        range: (a: number, b: number) => {
          call.range = [a, b];
          return run([a, b]);
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => run(null).then(res, rej),
      };
    },
    from(table: string) {
      const call: Call = { kind: "from", name: table, filters: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => (call.filters.push([`eq:${k}`, v]), chain),
        in: (k: string, v: unknown) => (call.filters.push([`in:${k}`, v]), chain),
        is: (k: string, v: unknown) => (call.filters.push([`is:${k}`, v]), chain),
        maybeSingle: () => Promise.resolve(settle(script.from?.(table, call.filters) ?? { data: [] })).then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(settle(script.from?.(table, call.filters) ?? { data: [] })).then(res, rej),
      };
      return chain;
    },
  };
  return { db: db as never, calls };
}
