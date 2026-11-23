import { build } from "esbuild";
await build({
  entryPoints: ["src/standalone/app.ts"],
  outfile: "dist/accoding.cjs",
  platform: "node",
  format: "cjs",
  target: ["node22"],
  bundle: true,
  packages: "bundle",
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" }
});
console.log("Built dist/accoding.cjs for Node.js (no Bun dependency).");
