// A scripted stand-in for a Supabase client: every query is recorded, and a handler decides the reply.
export interface Call {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: [string, unknown][];
  columns?: string;
  order: [string, boolean][];
  limit?: number;
  head: boolean;
}
export interface Reply {
  data?: unknown;
  error?: { message: string; code?: string } | null;
  count?: number | null;
}
export interface ClaimsReply {
  data: { claims: { sub?: string; email?: string } } | null;
  error: unknown;
}
export interface FakeOptions {
  claims?: ClaimsReply | ((jwt?: string) => ClaimsReply | Promise<ClaimsReply>);
  rpc?: (name: string, args: unknown) => Reply | undefined;
  users?: Record<string, { email?: string }>;
  userError?: { message: string };
}

export const signedIn = (sub: string, email = `${sub}@example.test`): ClaimsReply => ({ data: { claims: { sub, email } }, error: null });
export const signedOut: ClaimsReply = { data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing" } };

export function fakeDb(handler: (call: Call) => Reply | undefined = () => undefined, options: FakeOptions = {}) {
  const calls: Call[] = [];
  const rpcs: { name: string; args: unknown }[] = [];
  const reply = (r: Reply | undefined) => ({ data: null, error: null, count: null, ...r });

  const client = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [], order: [], head: false };
      const run = async () => {
        calls.push(call);
        return reply(handler(call));
      };
      const builder: Record<string, unknown> = {};
      const chain = (name: string, apply: (...a: unknown[]) => void) => {
        builder[name] = (...a: unknown[]) => {
          apply(...a);
          return builder;
        };
      };
      chain("select", (cols, opts) => {
        call.columns = String(cols ?? "");
        call.head = (opts as { head?: boolean } | undefined)?.head === true;
      });
      for (const op of ["insert", "update", "upsert"] as const) chain(op, (payload) => ((call.op = op), (call.payload = payload)));
      chain("delete", () => (call.op = "delete"));
      for (const f of ["eq", "neq", "ilike", "in", "is", "gt", "gte", "lt", "lte", "or"]) chain(f, (col, val) => call.filters.push([`${f}:${String(col)}`, val]));
      chain("order", (col, opts) => call.order.push([String(col), (opts as { ascending?: boolean } | undefined)?.ascending !== false]));
      chain("limit", (n) => (call.limit = Number(n)));
      chain("range", () => undefined);
      builder.maybeSingle = run;
      builder.single = run;
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject);
      return builder;
    },
    async rpc(name: string, args?: unknown) {
      rpcs.push({ name, args });
      return reply(options.rpc?.(name, args));
    },
    auth: {
      async getClaims(jwt?: string) {
        const c = options.claims ?? signedOut;
        return typeof c === "function" ? c(jwt) : c;
      },
      admin: {
        async getUserById(id: string) {
          if (options.userError) return { data: { user: null }, error: options.userError };
          return { data: { user: options.users?.[id] ?? null }, error: null };
        },
      },
    },
  };
  return { db: client as never, calls, rpcs };
}

export const wrote = (calls: Call[], table: string, op: Call["op"]) => calls.filter((c) => c.table === table && c.op === op);
export const filterValue = (call: Call, key: string) => call.filters.find(([k]) => k === key)?.[1];
