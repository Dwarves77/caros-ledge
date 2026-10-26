// `npm run schema:local`: the schema job on a workstation. Starts a throwaway PostgreSQL (scripts/ci/embedded-pg.mjs, PostgreSQL 15), runs scripts/ci/schema-apply.mjs against it, and stops and deletes the
// instance on every exit path. Extra arguments are passed to schema-apply. When schema-apply is green it then runs `npm run joinability:schema` (the very script the ci.yml schema job runs) against the same database with the same DATABASE_URL, so a text column the joinability pin lacks is red here, not only in CI.
import { spawn, spawnSync } from "node:child_process";

import { withEmbeddedPostgres } from "./embedded-pg.mjs";

let code = 1;
try {
  code = await withEmbeddedPostgres(
    (url) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["scripts/ci/schema-apply.mjs", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, DATABASE_URL: url } });
        child.on("exit", (c) => resolve(c === 0 ? (spawnSync("npm", ["run", "joinability:schema"], { shell: true, stdio: "inherit", env: { ...process.env, DATABASE_URL: url } }).status ?? 1) : (c ?? 1)));
      }),
    (m) => console.log(`schema:local: ${m}`),
  );
} catch (e) {
  console.error(`schema:local: ${e.message}`);
}
process.exit(code);
