// The persona clients of the workspace tests (tests/workspace/_world.ts), with their rpc routed to the shared MemDb's own rpc table, so a handler under test reads the database-function stand-ins of
// tests/_support/workspace-reads.ts through the caller's client exactly as it would the real ones. The service client is the whole database.
import { script } from "../workspace/_world.ts";
import type { MemDb as WorkspaceDb } from "../workspace/_memdb.ts";

import { scripted } from "./fake-clients.ts";
import type { MemDb } from "./memdb.ts";

export function scriptWithRpc(db: MemDb): MemDb {
  script(db as unknown as WorkspaceDb);
  const user = scripted.user as (request?: Request) => Promise<Record<string, unknown>> | Record<string, unknown>;
  const service = scripted.service as (request?: Request) => Record<string, unknown>;
  const rpc = (name: string, args?: Record<string, unknown>) => db.rpc(name, args ?? {});
  scripted.user = async (request) => ({ ...(await user(request)), rpc });
  scripted.service = (request) => ({ ...service(request), rpc });
  return db;
}
