import { build } from "esbuild";
import fs from "node:fs/promises";
const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
await build({
  entryPoints: ["src/standalone/app.ts"],
  outfile: "dist/accoding.mjs",
  platform: "node",
  format: "esm",
  target: ["node22"],
  bundle: true,
  packages: "bundle",
  minify: false,
  define: { __ACCODING_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" }
});
console.log("Built dist/accoding.mjs for Node.js (no Bun dependency).");
