// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/drizzle/**",
      "**/*.config.js",
      "**/*.config.mjs",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "off",
    },
  },

  // The agent container must never hold a database client. This is a checklist
  // item ("no database client anywhere in this workspace — verify by dependency
  // inspection"), enforced here so a stray import fails lint rather than review.
  {
    files: ["apps/agent/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "pg", message: "The agent is stateless and must never reach Postgres." },
            {
              name: "postgres",
              message: "The agent is stateless and must never reach Postgres.",
            },
            {
              name: "drizzle-orm",
              message: "The agent is stateless and must never reach Postgres.",
            },
          ],
          patterns: [
            {
              group: ["drizzle-orm/*", "@baton/core/db*"],
              message: "The agent is stateless and must never reach Postgres.",
            },
          ],
        },
      ],
    },
  },
);
