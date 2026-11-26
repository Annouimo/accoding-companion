// Prepare a reviewed public preview tarball; never invoke npm publish.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
const [version, observerVersion, output] = process.argv.slice(2);
const prerelease = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-(alpha|beta|rc)\.(0|[1-9][0-9]*)$/;
if (!prerelease.test(version ?? "") || !prerelease.test(observerVersion ?? "") || !output)
  throw Error("usage: prepare-npm-preview.mjs COMPANION_PRERELEASE OBSERVER_PRERELEASE NEW_OUTPUT_DIR");
const app="@routilet/accoding-companion", observer="@routilet/c-observer";
const root=process.cwd(), out=path.resolve(output);
assert.notEqual(out,root);
const npm=(args,cwd=root)=>execFileSync("npm",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","inherit"]});
const view=(name,field)=>JSON.parse(npm(["view",name,field,"--json","--fetch-retries=0","--fetch-timeout=15000"]));
const versions=view(app,"versions");
if ((Array.isArray(versions)?versions:[versions]).includes(version))
  throw Error("Companion version already published; choose a new version");
assert.equal(view(observer+"@"+observerVersion,"version"),observerVersion);
assert.equal(view(observer+"@next","version"),observerVersion);
const source=await fs.readFile("package.json","utf8"), original=JSON.parse(source);
assert.equal(original.name,app);
assert.equal(original.private,true);
assert.equal(original.repository?.url,"git+https://github.com/Routilet/accoding-companion.git");
await fs.mkdir(out);
const metadata={...original,version,optionalDependencies:{...original.optionalDependencies,[observer]:observerVersion},publishConfig:{...original.publishConfig,access:"public",tag:"next"}};
delete metadata.private;
try {
  await fs.writeFile("package.json",JSON.stringify(metadata,null,2)+"\n");
  console.log(npm(["run","build"]));
  console.log(npm(["pack","--ignore-scripts","--pack-destination",out]));
} finally {
  await fs.writeFile("package.json",source);
}
const files=(await fs.readdir(out)).filter(x=>x.endsWith(".tgz"));
assert.equal(files.length,1);
const packed=path.join(out,files[0]);
const test=await fs.mkdtemp(path.join(out,".verify-"));
try {
  // Only the Companion tarball is a direct install target. Observer must
  // resolve via the exact optional dependency in the public npm registry.
  console.log(npm(["install","--prefix",test,"--ignore-scripts","--no-audit","--no-fund",packed]));
  const base=path.join(test,"node_modules",app);
  const actual=JSON.parse(await fs.readFile(path.join(base,"package.json"),"utf8"));
  assert.equal(actual.name,app);
  assert.equal(actual.version,version);
  assert.equal(actual.private,undefined);
  assert.equal(actual.publishConfig?.tag,"next");
  assert.equal(actual.optionalDependencies?.[observer],observerVersion);
  const cli=path.join(base,"dist/accoding.mjs");
  const info=JSON.parse(execFileSync(process.execPath,[cli,"--installation-info"],{encoding:"utf8",cwd:test,env:{...process.env,ACCODING_MANAGED_V2:"1",ACCODING_OBSERVER_PATH:"",ACCODING_PRESET_PACKAGE:""}}));
  assert.equal(info.version,version);
  assert.equal(info.ready,true);
  assert.equal(info.components.find(c=>c.package==="@routilet/c-exam-kit")?.status,"ready");
  assert.equal(info.components.find(c=>c.package===observer)?.version,observerVersion);
  assert.equal(info.components.find(c=>c.package===observer)?.status,"ready");
  console.log(JSON.stringify(info,null,2));
} finally {
  await fs.rm(test,{recursive:true,force:true});
}
const sha=createHash("sha256").update(await fs.readFile(packed)).digest("hex");
await fs.writeFile(path.join(out,"SHA256SUMS"),sha+"  "+files[0]+"\n");
console.log("Verified next-only tarball (not published): "+packed);
