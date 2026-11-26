import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("./companion-release-plan.mjs",import.meta.url));
const mockNpm=`#!/usr/bin/env node
const [command,spec,field]=process.argv.slice(2);
if(command!=="view" || process.env.SCENARIO==="network") process.exit(1);
let value;
if(spec==="@routilet/accoding-companion" && field==="versions")
  value=process.env.SCENARIO==="new"?["0.2.7"]:["0.2.7","0.2.8"];
else if(spec.startsWith("@routilet/c-exam-kit@")) value="0.6.10";
else if(spec.startsWith("@routilet/c-observer@"))
  value=process.env.SCENARIO==="missing" && spec.endsWith("@latest")?"0.1.0-beta.2":"0.1.0";
else process.exit(1);
console.log(JSON.stringify(value));
`;
const mockGh=`#!/usr/bin/env node
const scenario=process.env.SCENARIO;
const assets=["darwin-amd64","darwin-arm64","windows-amd64","windows-arm64"].map(p=>({name:"accoding-launcher-0.3.0-"+p+".zip",state:"uploaded"}));
const release={tag_name:"launcher-v0.3.0",draft:false,prerelease:false,assets};
if(scenario==="partial") release.assets.pop();
console.log(JSON.stringify([["complete","partial"].includes(scenario)?[release]:[]]));
`;

function run(t,scenario,event="push",mode="AUTO") {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"release-plan-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const bin=path.join(dir,"bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,"npm"),mockNpm,{mode:0o755});
  fs.writeFileSync(path.join(bin,"gh"),mockGh,{mode:0o755});
  fs.writeFileSync(path.join(dir,"package.json"),JSON.stringify({name:"@routilet/accoding-companion",version:"0.2.8",dependencies:{"@routilet/c-exam-kit":"^0.6.10"},optionalDependencies:{"@routilet/c-observer":"^0.1.0"}}));
  fs.mkdirSync(path.join(dir,"launcher")); fs.writeFileSync(path.join(dir,"launcher/VERSION"),"0.3.0\n");
  const out=path.join(dir,"output"); fs.writeFileSync(out,"");
  const result=spawnSync(process.execPath,[script],{cwd:dir,encoding:"utf8",env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,GITHUB_OUTPUT:out,GITHUB_EVENT_NAME:event,GITHUB_REF:event==="pull_request"?"refs/pull/1/merge":"refs/heads/main",GITHUB_REPOSITORY:"Routilet/accoding-companion",REQUESTED_MODE:mode,EXPECTED_VERSION:"",EXPECTED_PRESET:"",EXPECTED_OBSERVER:"",SCENARIO:scenario}});
  return {...result,outputs:Object.fromEntries(fs.readFileSync(out,"utf8").trim().split("\n").filter(Boolean).map(s=>s.split("=")))};
}

test("main plans CLI and launcher in order; already released CLI is not republished",t=>{
  let r=run(t,"new"); assert.equal(r.status,0,r.stderr); assert.equal(r.outputs.publish,"true"); assert.equal(r.outputs.launcher,"true"); assert.equal(r.outputs.observer,"0.1.0");
  r=run(t,"launcher-only"); assert.equal(r.status,0,r.stderr); assert.equal(r.outputs.publish,"false"); assert.equal(r.outputs.launcher,"true");
  r=run(t,"complete"); assert.equal(r.status,0,r.stderr); assert.equal(r.outputs.publish,"false"); assert.equal(r.outputs.launcher,"false");
});
test("PR never reads registry or publishes; failed lookup and incomplete release stop",t=>{
  const pr=run(t,"network","pull_request"); assert.equal(pr.status,0,pr.stderr); assert.equal(pr.outputs.mode,"DRY_RUN"); assert.equal(pr.outputs.publish,"false"); assert.equal(pr.outputs.launcher,"false");
  for(const scenario of ["network","missing","partial"]) assert.notEqual(run(t,scenario).status,0,scenario);
});
