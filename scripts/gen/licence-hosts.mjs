// Writes src/core/fetch/licence-hosts.ts from the licence register (R2f F8): the hosts a prohibited verdict bars collecting from, as the import-free module the fetch guard and the Edge Function share.
// Run after the register changes: node --import ./tests/_support/register.mjs scripts/gen/licence-hosts.mjs ; tests/r2f/licence.test.ts fails when the committed file differs from what this writes.
import { writeFileSync } from "node:fs";

const { renderLicenceHostsModule } = await import("@/core/contracts");

writeFileSync("src/core/fetch/licence-hosts.ts", renderLicenceHostsModule());
console.log("src/core/fetch/licence-hosts.ts written");
