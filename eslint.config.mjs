import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/**
 * The one structural rule of this repository: a module's `core` folder is
 * plain TypeScript. It may not import NestJS, Express or anything outside a
 * `core` folder, so its tests never need a framework.
 */
const coreStaysFrameworkFree = {
  files: ["src/**/core/**/*.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["@nestjs/*", "express", "rxjs", "reflect-metadata"],
            message: "A core folder is framework-free. Put this in the controller or provider.",
          },
          {
            regex: "^\\.\\./(?!.*core/)",
            message: "A core folder imports only from core folders.",
          },
          {
            regex: "^\\./(?!.*core/).+/",
            message: "A core folder imports only from core folders.",
          },
        ],
      },
    ],
  },
};

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  coreStaysFrameworkFree,
  {
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["scripts/**"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
  globalIgnores(["dist/**", "coverage/**", ".railway/**", "supabase/**", ".dev-stack/**"]),
]);
