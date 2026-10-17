import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "node_modules/**"]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
        },
      ],
      "no-console": "error",
      "no-empty": ["error", { allowEmptyCatch: false }],
      // no-empty lets a comment stand in for a body; a catch that does nothing swallows the error, comment or not.
      "no-restricted-syntax": ["error", { selector: "CatchClause > BlockStatement[body.length=0]", message: "A catch must rethrow, record the error or return a stated failure; an empty catch (even with a comment) swallows it." }],
    },
  },
  {
    // IMP-106: the coverage feature has two barrels, the client-safe index and the server-only ./server; nothing outside it reaches into its directories.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/features/coverage/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: ["@/features/coverage/server/*", "@/features/coverage/ui/*", "@/features/coverage/api/*", "@/features/coverage/page", "@/features/coverage/client", "@/features/coverage/denominator-view"], message: "Import the coverage feature through its barrels: @/features/coverage (client-safe) or @/features/coverage/server (server only)." }] }],
    },
  },
  {
    files: ["src/core/shared/log.ts"],
    rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
  },
  {
    files: ["scripts/**/*.mjs", "tests/parity/*.mjs", "tests/ux/*.mjs"],
    rules: { "no-console": "off" },
  },
]);
