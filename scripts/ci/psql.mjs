// Synchronous SQL runner for the CI scripts: runs scripts/ci/pg-run.mjs (the `pg` client) and returns {status, stdout, stderr}.
// There is no psql binary in this path, so CI and a workstation run the same code. Options: file | sql, tuples (print rows), sep, stopOnError (default true).
import { spawnSync } from "node:child_process";

const CHILD = new URL("./pg-run.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export function psql(url, opts) {
  const r = spawnSync(process.execPath, [CHILD], { input: JSON.stringify({ url, ...opts }), encoding: "utf8", maxBuffer: 1 << 28 });
return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: `${r.stderr ?? ""}${r.error ? `psql: the client process could not run: ${r.error.message}\n` : ""}` };
}
