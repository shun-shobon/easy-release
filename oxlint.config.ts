import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
  },
  ignorePatterns: ["dist/**"],
  overrides: [
    {
      files: ["src/usecases/**/*.ts", "src/services/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/infra/**", "node:*", "octokit", "@actions/*"],
                message:
                  "Use service interfaces instead of external I/O implementations in usecases and services.",
              },
            ],
          },
        ],
      },
    },
  ],
});
