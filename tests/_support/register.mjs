// Test harness: lets `node --test` import the TypeScript sources with the "@/" alias and extensionless specifiers.
import { register } from "node:module";

import "./env.mjs";

register("./hooks.mjs", import.meta.url);
