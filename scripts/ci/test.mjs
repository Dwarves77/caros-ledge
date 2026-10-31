// `npm test`: node --test over every test file, with the file concurrency capped at max(2, floor(cores / 2)) so one lane cannot take every core of a shared workstation (GATES-LOCK-1). The one owner of the cap.
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";

import { isMain } from "../lib/fs.mjs";

export const testConcurrency = (cores = availableParallelism()) => Math.max(2, Math.floor(cores / 2));
/** `files` narrows the run to those test files (the pre-push hook's changed-module tests); by default every test file. */
export const testArgs = (cores, files = ["tests/**/*.test.mjs", "tests/**/*.test.ts"]) => ["--import", "./tests/_support/register.mjs", "--test", `--test-concurrency=${testConcurrency(cores)}`, ...files];

if (isMain(import.meta.url)) process.exit(spawnSync(process.execPath, testArgs(), { stdio: "inherit" }).status ?? 1);
