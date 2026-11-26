// Opt-in cross-repository fixture: exercise the real Companion workspace,
// preset assembly, native capability probe and JSON launch protocol.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../../src/workspace/store";
import { courseSettings } from "../../src/standalone/workspaces";
import { loadPreset } from "../../src/standalone/scaffold";
import { presetInclude, saveSharedPreset } from "../../src/standalone/preset-manager";
import { StandaloneWorkflow } from "../../src/standalone/workflow";
import { prepareObservation } from "../../src/standalone/observer";

async function main() {
  const root=path.resolve(process.argv[2] ?? "");
  const output=process.argv[3];
  if(!process.argv[2] || !output || !process.env.ACCODING_OBSERVER_PATH) throw Error("usage: ACCODING_OBSERVER_PATH=... tsx observer-session-fixture.ts ROOT OUTPUT");
  await fs.mkdir(root,{recursive:true});
  await courseSettings(root,"c");
  const store=new WorkspaceStore(root);
  const binding=await store.import({
    target:{kind:"problemset",problemId:"88001"},title:"Observer integration",label:"A",
    statement:{format:"markdown",content:"",baseUrl:"https://accoding.buaa.edu.cn/"},
    languages:["c"],warnings:[],special:false,
    samples:[{key:"first",input:"3\n3 0 7\n",expected:"10 36 3\n"}]
  });
  const source=path.join(root,binding.sourceFile);
  const preset=await loadPreset(path.resolve("scaffold/presets/example-c99"));
  const snap=await saveSharedPreset(root,preset,"0.1.0");
  const original='#include "'+presetInclude(source,snap.directory)+'"\n'+
    '#include <stdio.h>\n#include <math.h>\nint main(void) {\n'+
    '    int a[100010] = {0};\n    int n, sum = 0;\n    scanf("%d", &n);\n'+
    '    for (int i=0; i<n; ++i) {\n        scanf("%d", &a[i]);\n        sum += a[i];\n    }\n'+
    '    printf("%d %llu %.0f\\n", sum, exam_lcm_u64(12,18), sqrt((double)(sum-1)));\n'+
    '    return 0;\n}\n';
  await fs.writeFile(source,original);
  const app=new StandaloneWorkflow();
  try {
    const resolved=await app.resolve(source);
    const sample=resolved.binding.cases[0];
    const prepared=await prepareObservation(app,resolved,{caseId:sample.id,revision:sample.revision});
    const config=JSON.parse(await fs.readFile(prepared.sessionPath,"utf8"));
    try {
      assert.ok(config.sourceMap);
      assert.ok((await fs.readFile(path.join(path.dirname(prepared.sessionPath),config.sourcePath),"utf8")).includes('#line 1 "preset/'));
      assert.equal(await fs.readFile(source,"utf8"),original);
      await fs.writeFile(output,prepared.sessionPath);
      // Caller runs the actual debugger and removes the temporary session
      // after consuming it. Do not dispose here on successful handoff.
    } catch(error) {await prepared.dispose();throw error;}
  } finally {app.dispose();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
