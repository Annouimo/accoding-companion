import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { courseSettings } from "../../src/standalone/workspaces";
import { migrateLegacyWorkspace } from "../../src/standalone/migrate";
import { installedPresets, applyPresetVersion, undoPresetUpdate,
  chooseUpdateTargets } from "../../src/standalone/preset-manager";
import { loadPreset, renderHeader } from "../../src/standalone/scaffold";
import { StandaloneWorkflow, toolchain } from "../../src/standalone/workflow";
import { hash, type Problem } from "../../src/model";

const problem: Problem = {
  target: {kind:"problemset",problemId:"221"},
  title:"One input", label:"A",
  statement:{format:"markdown",content:"Read a value",baseUrl:"https://accoding.buaa.edu.cn/"},
  samples:[{key:"sample-1",input:"",expected:"36\n"}],
  languages:["c","cpp"], warnings:[], special:false
};

test("legacy import copies files without editing the old workspace", async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"accoding-migration-"));
  const oldRoot=path.join(temp,"old"),root=path.join(temp,"new");
  try {
    await fs.mkdir(oldRoot);
    await courseSettings(oldRoot,"c");
    const oldStore=new WorkspaceStore(oldRoot);
    const b=await oldStore.import(problem,"A-Old");
    const oldMain=path.join(oldRoot,b.sourceFile);
    const text=await fs.readFile(oldMain,"utf8");
    const legacy=path.join(oldRoot,".better-accoding","bindings");
    await fs.mkdir(legacy,{recursive:true});
    await fs.copyFile(path.join(oldRoot,".accoding","bindings",b.bindingId+".json"),
      path.join(legacy,b.bindingId+".json"));
    const report=await migrateLegacyWorkspace(oldRoot,root,"c");
    assert.deepEqual(report.skipped,[]);
    assert.equal(report.migrated,1);
    const migrated=(await new WorkspaceStore(root).list())[0];
    assert.equal(await fs.readFile(path.join(root,migrated.sourceFile),"utf8"),text);
    assert.equal(await fs.readFile(oldMain,"utf8"),text);
    assert.ok((await fs.readFile(path.join(root,path.dirname(migrated.sourceFile),"题目.md"),"utf8"))
      .includes("Read a value"));
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test("installed npm C99 data and per-question update preserve original code", async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"accoding-package-"));
  const previous=process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME=path.join(temp,"data");
  try {
    const root=path.join(temp,"course");
    await fs.mkdir(root);
    await courseSettings(root,"c");
    const store=new WorkspaceStore(root);
    const binding=await store.import(problem,"A-Test");
    const source=path.join(root,binding.sourceFile);
    const sourceCode='#include "exam.h"\n#include <stdio.h>\n'+
      'int main(void) {printf("%llu\\n",exam_lcm_u64(12,18));return 0;}\n';
    await fs.writeFile(source,sourceCode);
    const example=path.resolve("scaffold/presets/example-c99");
    const preset=await loadPreset(example);
    const active=path.join(root,".accoding","scaffold",binding.bindingId);
    await fs.mkdir(active,{recursive:true});
    await fs.cp(example,active,{recursive:true});
    const expanded=path.join(active,"expanded.h");
    await fs.writeFile(expanded,renderHeader(preset));
    const visible=path.join(root,"A-Test","exam.h");
    const relative=path.relative(path.dirname(source),expanded).split(path.sep).join("/");
    await fs.writeFile(visible, "#ifndef ACCODING_EXAM_WRAPPER_H\n#define ACCODING_EXAM_WRAPPER_H\n" +
      '#include "' + relative + '"\n#endif\n');
    const pkg=path.join(process.env.XDG_DATA_HOME!,"accoding-companion","presets","0.1.0",
      "node_modules","@annouimo","c-exam-kit-preset");
    await fs.mkdir(pkg,{recursive:true});
    await fs.writeFile(path.join(pkg,"package.json"),
      JSON.stringify({name:"@annouimo/c-exam-kit-preset",version:"0.1.0"}));
    await fs.cp(example,path.join(pkg,"preset"),{recursive:true});
    const installed=await installedPresets();
    assert.equal(installed.length,1);
    const marker=path.join(root,".accoding","initial-hashes",binding.bindingId+".json");
    await fs.mkdir(path.dirname(marker),{recursive:true});
    await fs.writeFile(marker,JSON.stringify({sourceHash:hash(sourceCode)}));
    const blank=await chooseUpdateTargets(root,[binding],"empty",()=>({}));
    assert.equal(blank.targets.length,1);
    await applyPresetVersion(root, binding, installed[0], toolchain());
    const updated = await fs.readFile(source, "utf8");
    assert.match(updated, /\.accoding\/presets\/0\.1\.0\/expanded\.h/);
    assert.equal(updated.replace(/#include "[^"]+"/, '#include "exam.h"'), sourceCode);
    const second = await store.import({ ...problem, target: { kind: "problemset", problemId: "321" } }, "B-Test");
    await fs.writeFile(path.join(root, second.sourceFile), updated);
    const app = new StandaloneWorkflow();
    try {
      const left = await app.prepare(await app.resolve(source));
      const right = await app.prepare(await app.resolve(path.join(root, second.sourceFile)));
      assert.equal(left.code, right.code);
    } finally { app.dispose(); }
    assert.equal((await fs.readdir(path.join(root, ".accoding", "presets")))
      .filter((name) => name === "0.1.0").length, 1);
    await undoPresetUpdate(root, binding);
    const undone = await fs.readFile(source, "utf8");
    assert.match(undone, /\.accoding\/presets\/local-[a-f0-9]{64}\/expanded\.h/);
    assert.equal(undone.replace(/#include "[^"]+"/, '#include "exam.h"'), sourceCode);
  } finally {
    if(previous===undefined)delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME=previous;
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test("missing C99 package gives an actionable error while C++17 needs no preset", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-no-preset-"));
  const previous = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(temp, "data");
  const app = new StandaloneWorkflow();
  try {
    const cRoot = path.join(temp, "c-course");
    const cppRoot = path.join(temp, "cpp-course");
    await fs.mkdir(cRoot);
    await fs.mkdir(cppRoot);
    await courseSettings(cRoot, "c");
    await courseSettings(cppRoot, "cpp");
    await assert.rejects(() => app.activePreset(undefined, cRoot), /C Exam Kit/);
    assert.equal(await app.activePreset(undefined, cppRoot), undefined);
  } finally {
    app.dispose();
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});
