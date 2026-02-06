import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/internals.ts"],
  format: ["cjs", "esm"],
  platform: "neutral",
  dts: true,
  outDir: "./dist",
});
