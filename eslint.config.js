import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // src/generated is openapi-typescript output; never hand-edited, not linted.
  { ignores: ["dist", "node_modules", "coverage", "src/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,mjs}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    files: ["src/**/*.ts"],
    rules: { "no-console": "error" },
  },
);
