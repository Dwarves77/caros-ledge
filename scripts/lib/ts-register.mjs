// Registers the TypeScript hooks for a production CLI: the real database clients, no stand-ins. `node --import ./scripts/lib/ts-register.mjs <script>`.
import { register } from "node:module";

register("./ts-hooks.mjs", import.meta.url, { data: {} });
