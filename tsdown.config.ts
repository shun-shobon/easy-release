import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  deps: { alwaysBundle: [/.*/], onlyBundle: false },
  sourcemap: false,
  dts: false,
});
