// `npm ci` / `npm install` run this (package.json "prepare"): points git at the versioned hooks. Never fails an install (no .git in a build checkout).
import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  console.log("prepare: not a git checkout, so the push hook is not installed");
}
