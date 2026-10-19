// The scratch tree a mutant is applied to: a clone of the repository (its own .git, its own node_modules from `npm ci`; never a link into the real tree), with the real tree's uncommitted work laid over it and
// committed as a base. Between mutants `restore` returns it to that base, so each mutant sees the tree exactly as it is and nothing else. Deleting the scratch is a plain recursive delete.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { execIn } from "./run.mjs";

const git = (dir, ...args) => {
  const r = execIn(dir, "git", args, {}, 300_000);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.output.trim().slice(0, 300)}`);
  return r.output.trim();
};
const sha = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "none");
const LOCK_STAMP = ".mutants-lock";

/** The files of a working tree: tracked and untracked, minus ignored. */
const listFiles = (dir) => git(dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter((f) => f && existsSync(join(dir, f)));

/**
 * Clone `root` into `dir` (once; later calls reuse it), run `npm ci` when package-lock.json changed since, lay root's working tree over the clone and commit it. Returns the base commit.
 * `reuse` false removes an existing scratch first.
 */
export function prepareScratch(root, dir, { log = () => undefined, reuse = true } = {}) {
  if (!reuse && existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (!existsSync(join(dir, ".git"))) {
    log(`scratch: cloning ${root} into ${dir}`);
    mkdirSync(dirname(dir), { recursive: true });
    git(root, "clone", "--quiet", "--no-hardlinks", ".", dir);
    git(dir, "config", "user.name", "mutants");
    git(dir, "config", "user.email", "mutants@invalid.example");
  } else restore(dir);
  // The working tree of root over the clone: copy what differs, delete what root deleted.
  const want = new Set(listFiles(root));
  const have = new Set(git(dir, "ls-files", "-z").split("\0").filter(Boolean));
  for (const f of have) if (!want.has(f)) rmSync(join(dir, f), { force: true });
  for (const f of want) {
    const [from, to] = [join(root, f), join(dir, f)];
    if (!existsSync(to) || !readFileSync(from).equals(readFileSync(to))) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
  const stamp = join(dir, "node_modules", LOCK_STAMP);
  const lock = sha(join(root, "package-lock.json"));
  if (!existsSync(join(dir, "node_modules")) || (existsSync(stamp) ? readFileSync(stamp, "utf8") : "") !== lock) {
    log("scratch: npm ci (the scratch has its own node_modules)");
    const r = execIn(dir, "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], {}, 900_000);
    if (r.code !== 0) throw new Error(`npm ci failed in the scratch: ${r.output.slice(-400)}`);
    writeFileSync(stamp, lock); // which package-lock.json this node_modules was installed from
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "--allow-empty", "-m", "base");
  return git(dir, "rev-parse", "HEAD");
}

/** Return the scratch to its base commit: tracked files as committed, untracked files gone (ignored files such as node_modules stay). */
export function restore(dir) {
  git(dir, "reset", "--hard", "--quiet");
  git(dir, "clean", "-fdq");
}
