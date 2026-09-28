import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node22",
  // tsup strips the `node:` prefix by default, for bundlers that predate it.
  // `node:sqlite` has no unprefixed name to fall back on, so the built package
  // imported a package called "sqlite" and failed to resolve it.
  removeNodeProtocol: false,
});
