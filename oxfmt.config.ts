import { defineConfig } from "oxfmt";

export default defineConfig({
  ignorePatterns: ["dist/**", "mise.lock", "pnpm-lock.yaml"],
  sortImports: {
    groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
  },
  sortPackageJson: {
    sortScripts: true,
  },
});
