import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { observerBinaryFromManifest } from "../../src/standalone/observer";
test("observer package chooses compatible native executable",()=>{
  const root=path.resolve("package");
  const manifest={schemaVersion:1,sessionSchemaVersions:[1],platforms:{"darwin-arm64":{executable:"bin/darwin-arm64/c-observer"}}};
  assert.equal(observerBinaryFromManifest(root,manifest,"darwin","arm64"),path.join(root,"bin/darwin-arm64/c-observer"));
  assert.throws(()=>observerBinaryFromManifest(root,manifest,"win32","x64"),/尚未提供/);
  assert.throws(()=>observerBinaryFromManifest(root,{...manifest,sessionSchemaVersions:[2]},"darwin","arm64"),/协议/);
  assert.throws(()=>observerBinaryFromManifest(root,{...manifest,platforms:{"darwin-arm64":{executable:"../escape"}}},"darwin","arm64"),/路径/);
});
