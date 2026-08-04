// eslint.config.mjs — ESLint 9 flat config
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "reports/**", "test-results/**", "playwright-report/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 默認：Node 環境（腳本、測試）
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 瀏覽器環境（content-script、fixture、渲染層）
    files: ["src/**/*.ts", "test/fixtures/**/*.js", "test/e2e/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  }
);
