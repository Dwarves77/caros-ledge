import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The two barriers (see the config objects below): IMP-106 coverage barrels, PROP-044 Community feeds nothing.
const COVERAGE_BARRIER = { group: ["@/features/coverage/server/*", "@/features/coverage/ui/*", "@/features/coverage/api/*", "@/features/coverage/page", "@/features/coverage/client", "@/features/coverage/denominator-view"], message: "Import the coverage feature through its barrels: @/features/coverage (client-safe) or @/features/coverage/server (server only)." };
const COMMUNITY_BARRIER = { group: ["**/community", "**/community/**"], message: "PROP-044: Community feeds nothing. Code outside the Community directories does not import Community code." };

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
    // Two import barriers on src, in one rule (a later config object replaces an earlier one's options, so they are listed together and each exemption restates the other barrier).
    // IMP-106: the coverage feature has two barrels, the client-safe index and the server-only ./server; nothing outside it reaches into its directories.
    // PROP-044 (ADR-041): Community feeds nothing. No module outside the Community directories imports Community code. The one thing that crosses is a URL (the shell's bell polls /api/community/notifications).
    files: ["src/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: [COVERAGE_BARRIER, COMMUNITY_BARRIER] }] },
  },
  {
    files: ["src/features/coverage/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [COMMUNITY_BARRIER] }] },
  },
  {
    // The Community directories and the one UX fixture mount that renders them (a test mount, which feeds nothing).
    files: ["src/features/community/**", "src/app/community/**", "src/app/api/community/**", "src/app/privacy/ui-fixtures/community/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [COVERAGE_BARRIER] }] },
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
