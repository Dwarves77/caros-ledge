// withLock(name, fn, { dir }): a cross-process lock for the heavy gates (GATES-LOCK-1, scoped by GATES-FIX-1). Two runs in ONE clone must never run `next build`, `node --test` and `schema:local` at once (they share its .next and test-output.txt),
// so each takes <dir>/<name>.lock (an atomic mkdir; mkdir fails for everyone but one) holding holder.json {pid, at}. gates.mjs passes <git-dir>/gates-lock, so there is one lock per clone and independent clones never wait for each other (the embedded
// PostgreSQL takes its own temp dir and free port, so nothing else is shared). A waiter polls, saying once a minute who it waits for. A lock whose pid is not alive, or older than staleMs, is broken (renamed away first, so only one waiter breaks it).
// The holder releases in finally, on exit and on SIGINT/SIGTERM. CI runners are isolated: no lock there.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gone = (path) => rmSync(path, { recursive: true, force: true });

/** Who holds `lock`: its holder.json, else (the holder is between mkdir and its first write, or crashed there) pid 0 and the directory's age; null when the lock is gone. */
function holder(lock) {
  try {
    return JSON.parse(readFileSync(join(lock, "holder.json"), "utf8"));
  } catch {
    try {
      return { pid: 0, at: statSync(lock).mtimeMs };
    } catch {
      return null;
    }
  }
}

export async function withLock(name, fn, { staleMs = 45 * 60_000, pollMs = 5_000, dir, log = console.log, ci = Boolean(process.env.CI || process.env.GITHUB_ACTIONS) } = {}) {
  if (ci) return fn();
  const lock = join(dir, `${name}.lock`);
  mkdirSync(dir, { recursive: true });
  let told = 0;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const h = holder(lock);
    if (!h) continue;
    if (Date.now() - h.at > staleMs || (h.pid > 0 && !alive(h.pid))) {
      const moved = `${lock}.broken-${process.pid}`;
      try {
        renameSync(lock, moved);
      } catch {
        continue; // another waiter broke it, or the holder released it
      }
      const now = holder(moved);
      if (now && now.pid && (now.pid !== h.pid || now.at !== h.at)) {
        try {
          renameSync(moved, lock); // a new holder took it between our read and the rename: put it back
        } catch {
          gone(moved);
        }
        continue;
      }
      gone(moved);
      log(`${name}: broke a stale lock held by ${h.pid} since ${new Date(h.at).toISOString()}`);
      continue;
    }
    if (Date.now() - told >= 60_000) {
      told = Date.now();
      log(`${name}: waiting for ${h.pid} since ${new Date(h.at).toISOString()}`);
    }
    await sleep(pollMs);
  }
  const mine = { pid: process.pid, at: Date.now() };
  writeFileSync(join(lock, "holder.json"), JSON.stringify(mine));
  const release = () => {
    const h = holder(lock);
    if (h && h.pid === mine.pid && h.at === mine.at) gone(lock); // never delete a lock that was broken and re-taken by another process
  };
  const onInt = () => (release(), process.exit(130));
  const onTerm = () => (release(), process.exit(143));
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("exit", release);
  try {
    return await fn();
  } finally {
    release();
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("exit", release);
  }
}
