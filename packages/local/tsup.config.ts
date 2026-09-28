import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  // See the note in packages/openrag/tsup.config.ts: tsup rewrites `node:x` to
  // `x` by default, which breaks the built-ins that have no unprefixed name.
  removeNodeProtocol: false,
});
