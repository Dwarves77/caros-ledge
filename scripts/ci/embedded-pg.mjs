// A throwaway PostgreSQL 15 (the embedded-postgres devDependency) in a temp data dir on a free port, for a workstation with no Docker and no system Postgres. `withEmbeddedPostgres(fn)` starts it, calls
// `fn(url)` with the bootstrap superuser's URL, and stops it and deletes its directory on every exit path, a signal included. Used by `npm run schema:local` and by the mutants runner's schema gates.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import EmbeddedPostgres from "embedded-postgres";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// The server logs no ERROR (its start-up LOG line, which embedded-postgres waits for, is kept): its log pipe is read by this process, and a caller that blocks the event loop (the mutants runner runs its gates synchronously) would stop reading it, fill the pipe and hang the
// server inside the next statement that logs an error. Every error a check wants to see comes back to the client.
export async function withEmbeddedPostgres(fn, log = console.log) {
  const dir = mkdtempSync(join(tmpdir(), "schema-local-"));
  const port = await freePort();
  const pgdb = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-c", "log_min_messages=log", "-c", "log_min_error_statement=panic"], onLog: () => undefined, onError: () => undefined });
  let stopping = false;
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    await pgdb.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const onSignal = () => cleanup().finally(() => process.exit(130));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, onSignal);
  try {
    await pgdb.initialise();
    await pgdb.start();
    log(`PostgreSQL on port ${port}`);
    return await fn(`postgresql://postgres:postgres@127.0.0.1:${port}/postgres`);
  } finally {
    await cleanup();
    for (const sig of ["SIGINT", "SIGTERM"]) process.off(sig, onSignal);
  }
}
