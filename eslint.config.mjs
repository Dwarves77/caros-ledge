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
    files: ["src/core/shared/log.ts"],
    rules: { "no-console": ["error", { allow: ["error", "warn"] }] },
  },
  {
    files: ["scripts/**/*.mjs", "tests/parity/*.mjs", "tests/ux/*.mjs"],
    rules: { "no-console": "off" },
  },
]);
