// `npm run schema:local`: the schema job on a workstation. Starts a throwaway PostgreSQL (the embedded-postgres devDependency, PostgreSQL 15)
// in a temp data dir on a free port, runs scripts/ci/schema-apply.mjs against it, and stops and deletes the instance on every exit path.
import { spawn } from "node:child_process";
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

const dir = mkdtempSync(join(tmpdir(), "schema-local-"));
const port = await freePort();
const pgdb = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
let child = null;
let stopping = false;

async function cleanup() {
  if (stopping) return;
  stopping = true;
  child?.kill();
  await pgdb.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => cleanup().finally(() => process.exit(130)));
}

let code = 1;
try {
  await pgdb.initialise();
  await pgdb.start();
  console.log(`schema:local: PostgreSQL on port ${port}`);
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  code = await new Promise((resolve) => {
    child = spawn(process.execPath, ["scripts/ci/schema-apply.mjs"], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
    child.on("exit", (c) => resolve(c ?? 1));
  });
} catch (e) {
  console.error(`schema:local: ${e.message}`);
} finally {
  await cleanup();
}
process.exit(code);
