// Test harness: lets `node --test` import the TypeScript sources with the "@/" alias and extensionless specifiers, with the database clients replaced by the scripted stand-ins.
import { register } from "node:module";

import "./env.mjs";

register("../../scripts/lib/ts-hooks.mjs", import.meta.url, { data: { fakeClients: new URL("./fake-clients.ts", import.meta.url).href } });
