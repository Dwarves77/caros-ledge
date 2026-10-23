// scripts/ci/checks/client-walk.mjs can fail (audit 2.4, bundle hardening): a "use client" file may not reach a server-only module, node:crypto, or a file that reads a secret from process.env, by any chain of
// imports. Each rule has a planted chain that turns it red and a clean twin that stays green; the check is run as a program on a throwaway tree, as the gates run it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const SCRIPT = resolve("scripts/ci/checks/client-walk.mjs");
const SERVER = {
  "src/core/http/guard.ts": "export const requireUser = 1;\n",
  "src/core/db/clients.ts": "export const serviceClient = 1;\n",
  "src/core/shared/telemetry.ts": "export const withErrorCapture = 1;\n",
  "src/core/http/rate-limit.ts": "export const limit = 1;\n",
  "src/core/auth/platform-admin.ts": "export const isAdmin = 1;\n",
};

function run(files) {
  const dir = mkdtempSync(join(tmpdir(), "clientwalk-"));
  for (const [rel, text] of Object.entries({ ...SERVER, ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: "utf8" });
}
const CLIENT = '"use client";\n';

test("a clean tree passes: client files import pure helpers, types of server modules and NEXT_PUBLIC variables", () => {
  const r = run({
    "src/ui/A.tsx": `${CLIENT}import type { Db } from "@/core/db/clients";\nimport { helper } from "@/core/pure";\nexport const A = () => helper(process.env.NEXT_PUBLIC_APP_URL, process.env.NODE_ENV);\n`,
    "src/core/pure.ts": 'export const helper = (...a: unknown[]) => a;\nexport type { Db } from "@/core/db/clients";\n',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /client-walk: clean \(1 client file/);
});

test("each server-only module is red, directly and through a chain, and the chain is printed", () => {
  for (const server of Object.keys(SERVER)) {
    const direct = run({ "src/ui/A.tsx": `${CLIENT}import { x } from "@/${server.slice(4).replace(/\.ts$/, "")}";\nexport const A = x;\n` });
    assert.equal(direct.status, 1, server);
    assert.match(direct.stderr, new RegExp(`src/ui/A\\.tsx -> ${server.replaceAll(".", "\\.")}`));
    const chained = run({ "src/ui/A.tsx": `${CLIENT}import { m } from "../core/mid";\nexport const A = m;\n`, "src/core/mid.ts": `export { y as m } from "./deep";\n`, "src/core/deep.ts": `import { x } from "@/${server.slice(4).replace(/\.ts$/, "")}";\nexport const y = x;\n` });
    assert.equal(chained.status, 1, `${server} through a re-export`);
    assert.match(chained.stderr, /src\/ui\/A\.tsx -> src\/core\/mid\.ts -> src\/core\/deep\.ts -> /);
  }
});

test("a dynamic import counts; a type-only import and an `import type` re-export do not", () => {
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}export const load = () => import("@/core/http/guard");\n` }).status, 1);
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}import type { requireUser } from "@/core/http/guard";\nexport type T = typeof requireUser;\n` }).status, 0);
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}import { type requireUser } from "@/core/http/guard";\nexport type T = typeof requireUser;\n` }).status, 0);
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}export type { requireUser } from "@/core/http/guard";\n` }).status, 0);
});

test("node:crypto (and bare crypto) is red under a client file, green in a server-only file nobody client imports", () => {
  for (const spec of ["node:crypto", "crypto"]) {
    const r = run({ "src/ui/A.tsx": `${CLIENT}import { m } from "@/core/mid";\nexport const A = m;\n`, "src/core/mid.ts": `import { randomBytes } from "${spec}";\nexport const m = randomBytes;\n` });
    assert.equal(r.status, 1, spec);
    assert.match(r.stderr, new RegExp(`src/core/mid\\.ts -> ${spec.replace(":", ":")}`));
  }
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}export const A = 1;\n`, "src/core/server-only.ts": 'import { randomBytes } from "node:crypto";\nexport const m = randomBytes;\n' }).status, 0);
});

test("a reachable file that reads a non-public environment variable is red; NEXT_PUBLIC_ and NODE_ENV are fine; so is a server file no client reaches", () => {
  const reads = (expr) => run({ "src/ui/A.tsx": `${CLIENT}import { m } from "@/core/mid";\nexport const A = m;\n`, "src/core/mid.ts": `export const m = ${expr};\n` });
  assert.equal(reads("process.env.SUPABASE_SERVICE_ROLE_KEY").status, 1);
  assert.match(reads("process.env.WORKER_SECRET").stderr, /reads process\.env\.WORKER_SECRET/);
  assert.equal(reads("process.env[name()]").status, 1, "a computed name could be anything");
  assert.equal(reads("{ ...process.env }").status, 1, "the whole environment");
  assert.equal(reads("process.env.NEXT_PUBLIC_SUPABASE_URL").status, 0);
  assert.equal(reads("process.env.NODE_ENV").status, 0);
  assert.equal(run({ "src/ui/A.tsx": `${CLIENT}export const A = 1;\n`, "src/core/server.ts": "export const m = process.env.WORKER_SECRET;\n" }).status, 0);
});

test("a file with no directive is not a client file, and a directive after other code is not a directive", () => {
  assert.equal(run({ "src/ui/A.tsx": 'import { x } from "@/core/http/guard";\nexport const A = x;\n' }).status, 0);
  assert.equal(run({ "src/ui/A.tsx": '// "use client"\nimport { x } from "@/core/http/guard";\nexport const A = x;\n' }).status, 0);
  assert.equal(run({ "src/ui/A.tsx": '/* header */\n"use client";\nimport { x } from "@/core/http/guard";\nexport const A = x;\n' }).status, 1, "a comment before the directive is fine");
});
