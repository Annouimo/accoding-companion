// Read-only release rehearsal: all packages stay private and local.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
const [observerDir, installDir] = process.argv.slice(2);
if (!observerDir || !installDir) throw Error("usage: verify-candidate-install.mjs OBSERVER_DIST INSTALL_DIR");
const root = process.cwd();
const tarballs = (await fs.readdir(observerDir)).filter(n => n.endsWith(".tgz"));
assert.equal(tarballs.length,1);
const observer = path.resolve(observerDir,tarballs[0]);
const candidate = path.resolve(installDir);
await fs.mkdir(candidate);
const build = path.join(candidate,"package-build");
await fs.mkdir(build);
const original = JSON.parse(await fs.readFile("package.json","utf8"));
assert.equal(original.private,true);
const metadata = {...original,version:"0.2.8-dev.1",optionalDependencies:{"@routilet/c-observer":"0.1.0-dev.1"}};
const saved = await fs.readFile("package.json","utf8");
const npm = (...args) => execFileSync("npm",args,{stdio:"inherit",cwd:root});
try {
  await fs.writeFile("package.json",JSON.stringify(metadata,null,2)+"\n");
  npm("run","build");
  npm("pack","--ignore-scripts","--pack-destination",build);
} finally {
  await fs.writeFile("package.json",saved);
}
const packs = (await fs.readdir(build)).filter(n=>n.endsWith(".tgz"));
assert.equal(packs.length,1);
const target = path.join(candidate,"installed");
await fs.mkdir(target);
npm("install","--prefix",target,"--ignore-scripts","--no-audit","--no-fund",path.join(build,packs[0]),observer);
const cli = path.join(target,"node_modules/@routilet/accoding-companion/dist/accoding.mjs");
const result = JSON.parse(execFileSync(process.execPath,[cli,"--installation-info"],{encoding:"utf8",cwd:target,env:{...process.env,ACCODING_MANAGED_V2:"1"}}));
assert.equal(result.version,metadata.version);
assert.equal(result.ready,true);
assert.equal(result.components.find(c=>c.package==="@routilet/c-exam-kit")?.status,"ready");
assert.equal(result.components.find(c=>c.package==="@routilet/c-observer")?.status,"ready");
assert.equal(result.components.find(c=>c.package==="@routilet/c-observer")?.version,"0.1.0-dev.1");
console.log(JSON.stringify(result,null,2));
console.log("Private candidate installation verified; no package was published.");
