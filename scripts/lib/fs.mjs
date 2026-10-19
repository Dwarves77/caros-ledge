// Shared file helpers for the scripts: posix path keys, a directory walk and the one "was this file run directly" test. Every script that builds a path key, walks a tree or guards its main
// takes it from here; a second copy of any of the three is a defect (R1b: loc.mjs built backslash keys on Windows because it had its own).
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** A path with forward slashes: Windows `join` returns backslashes, and every table, key and message here is posix. */
export const posix = (p) => p.split("\\").join("/");

/** Every file under `dir` (posix paths, `dir` first) whose name `accept` takes, depth first, in name order. */
export function walk(dir, accept = () => true) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => (e.isDirectory() ? walk(`${posix(dir)}/${e.name}`, accept) : accept(e.name) ? [`${posix(dir)}/${e.name}`] : []));
}

/** True when the module at `metaUrl` is the script node was started with. */
export const isMain = (metaUrl) => Boolean(process.argv[1]) && metaUrl === pathToFileURL(process.argv[1]).href;
