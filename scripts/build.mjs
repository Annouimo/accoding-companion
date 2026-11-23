import { build } from "esbuild";
import fs from "node:fs/promises";
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
await build({
  entryPoints: ["src/standalone/app.ts"],
  outfile: "dist/accoding.cjs",
  platform: "node",
  format: "cjs",
  target: ["node22"],
  bundle: true,
  packages: "bundle",
  minify: false,
  define: { __ACCODING_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" }
});
console.log("Built dist/accoding.cjs for Node.js (no Bun dependency).");
