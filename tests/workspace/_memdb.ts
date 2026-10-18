// The workspace tests' face of the one shared memory database (tests/_support/memdb.ts): unique keys, generated name keys, an updated_at that moves on every update, uuid ids with a created_at tick,
// the two embeds the workspace reads, and failures with a use count. `memClient(db, who)` is the client a handler gets, with the signed-in answers of `who`.
import { MemDb as Shared, type Err, type Row } from "../_support/memdb.ts";

export type { Row };
export type DbError = NonNullable<Err>;
export interface Logged {
  table: string;
  op: string;
  payload?: unknown;
  filters: [string, string, unknown][];
}

const UNIQUE: Record<string, string[][]> = {
  workspace_tags: [["org_id", "name_key"]],
  item_workspace_tags: [["tag_id", "intelligence_item_id"]],
  portfolios: [["org_id", "name_key"]],
  portfolio_members: [["portfolio_id", "item_id"], ["portfolio_id", "entity_id"]],
  workspace_item_overrides: [["org_id", "item_id"]],
  user_item_state: [["user_id", "item_id"]],
  item_assignments: [["item_id", "assignee_user_id"]],
};

export class MemDb extends Shared {
  constructor(seed: Record<string, Row[]> = {}) {
    super({ ids: "uuid", unique: UNIQUE, generatedKey: ["workspace_tags", "portfolios"], touched: ["workspace_settings"], relations: { "org_memberships.profiles": ["user_id", "id"], "user_item_state.intelligence_items": ["item_id", "id"] } }, seed);
  }
  get log(): Logged[] {
    return this.calls;
  }
  /** The next injected failure for a call; the workspace world's emulated rpcs ask by (table, op, filters). */
  override takeFailure(first: Parameters<Shared["takeFailure"]>[0] | string, op?: string, filters: [string, string, unknown][] = []): Err {
    return super.takeFailure(typeof first === "string" ? { table: first, op: op as never, filters } : first);
  }
  /** Inject a failure: `times` matching calls fail (omitted: every one); `when` sees the call's filters. */
  override fail(table: string, op: Parameters<Shared["fail"]>[1], error: DbError | string = { message: "boom" }, opts: { times?: number; when?: (filters: [string, string, unknown][]) => boolean } = {}): this {
    const e = typeof error === "string" ? { message: error } : error;
    return super.fail(table, op, e.message, { ...(e.code ? { code: e.code } : {}), ...(opts.times === undefined ? {} : { times: opts.times }), ...(opts.when ? { when: (c) => opts.when?.(c.filters) ?? true } : {}) });
  }
}

export interface Who {
  claims: { sub: string; email: string } | null;
  admin?: boolean;
}

/** A client over `db`. `who` decides what getClaims answers (null is signed out) and what is_platform_admin answers. */
export function memClient(db: MemDb, who: Who | null = null) {
  return {
    from: (table: string) => db.from(table),
    async rpc(name: string, args?: unknown) {
      db.rpcCalls.push({ name, args: (args ?? {}) as Record<string, unknown> });
      const refused = db.rpcFail.get(name);
      if (refused) return { data: null, error: refused };
      if (name === "is_platform_admin") return { data: who?.admin === true, error: null };
      const fn = db.rpcs[name] as unknown as ((a: unknown, who: Who | null) => unknown) | undefined;
      if (!fn) return { data: null, error: { message: `no rpc ${name}`, code: "PGRST202" } };
      try {
        return { data: fn(args, who), error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e), ...((e as { code?: string }).code ? { code: (e as { code: string }).code } : {}) } };
      }
    },
    auth: {
      async getClaims() {
        return who?.claims ? { data: { claims: who.claims }, error: null } : { data: null, error: { name: "AuthSessionMissingError", message: "Auth session missing" } };
      },
    },
  } as never;
}
