import {test} from "node:test";
import assert from "node:assert/strict";
import {installationInfo,observerBinaryFromManifest} from "../../src/standalone/installation-info";

test("installation info checks the real npm C Exam Kit without global fallback",async()=>{
  const info=await installationInfo("0.2.8-beta.1",{resolve:()=>undefined});
  assert.equal(info.schemaVersion,1);
  assert.equal(info.ready,true);
  assert.match(info.components[0].version??"",/^0\.6\.(?:9|[1-9][0-9]+)$/);
  assert.equal(info.components[1].status,"not-installed");
});

test("missing or invalid required package prevents activation",async()=>{
  const missing=await installationInfo("0.2.8",{preset:async()=>undefined,resolve:()=>undefined});
  assert.equal(missing.ready,false);
  assert.equal(missing.components[0].status,"not-installed");
  const invalid=await installationInfo("0.2.8",{preset:async()=>{throw Error("corrupt")},resolve:()=>undefined});
  assert.equal(invalid.ready,false);
  assert.equal(invalid.components[0].status,"invalid");
});

test("observer manifest paths and protocols are checked",()=>{
  assert.throws(()=>observerBinaryFromManifest("/root",{schemaVersion:1,sessionSchemaVersions:[1],platforms:{"darwin-arm64":{executable:"../escape"}}},"darwin","arm64"),/路径/);
  assert.throws(()=>observerBinaryFromManifest("/root",{schemaVersion:2},"darwin","arm64"),/协议/);
});
