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
