import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { courseSettings } from "../../src/standalone/workspaces";
import { migrateLegacyWorkspace } from "../../src/standalone/migrate";
import { execFileSync } from "node:child_process";
import { installedPresets, setCoursePresetVersion, applyPresetVersion, undoPresetUpdate,
  chooseUpdateTargets, presetInclude, saveSharedPreset } from "../../src/standalone/preset-manager";
import { loadPreset, renderHeader } from "../../src/standalone/scaffold";
import { StandaloneWorkflow, toolchain } from "../../src/standalone/workflow";
import { cTemplate } from "../../src/workspace/sources";
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
  const previousPrefix = process.env.npm_config_prefix;
  const previousLegacyOnly = process.env.ACCODING_PRESET_LEGACY_ONLY;
  process.env.ACCODING_PRESET_LEGACY_ONLY = "1";
  process.env.npm_config_prefix = path.join(temp, "npm global");
  try {
    const root=path.join(temp,"course");
    await fs.mkdir(root);
    await courseSettings(root,"c");
    const store=new WorkspaceStore(root);
    const binding=await store.import(problem,"A-Test");
    const source=path.join(root,binding.sourceFile);
    const sourceCode='#include "exam.h"\n#include <stdio.h>\n/* example\n#include "exam.h"\n*/\n'+
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
    assert.deepEqual((await installedPresets()).map((entry) => entry.version), ["0.1.0"]);
    const windows = process.platform === "win32";
    const npmRoot = execFileSync(windows ? process.env.ComSpec || "cmd.exe" : "npm",
      windows ? ["/d", "/s", "/c", "npm.cmd root --global"] : ["root", "--global"],
      { encoding: "utf8" }).trim();
    const global = path.join(npmRoot, "@annouimo", "c-exam-kit-preset");
    await fs.mkdir(path.dirname(global), { recursive: true });
    await fs.cp(pkg, global, { recursive: true });
    await fs.writeFile(path.join(global, "package.json"),
      JSON.stringify({ name: "@annouimo/c-exam-kit-preset", version: "0.2.0" }));
    const newGlobal = path.join(npmRoot, "@routilet", "c-exam-kit");
    await fs.mkdir(path.dirname(newGlobal), { recursive: true });
    await fs.cp(global, newGlobal, { recursive: true });
    await fs.writeFile(path.join(newGlobal, "package.json"),
      JSON.stringify({ name: "@routilet/c-exam-kit", version: "0.2.0" }));
    const installed = await installedPresets();
    assert.deepEqual(installed.map((entry) => entry.version), ["0.2.0"]);
    await setCoursePresetVersion(root, "0.2.0");
    const marker=path.join(root,".accoding","initial-hashes",binding.bindingId+".json");
    await fs.mkdir(path.dirname(marker),{recursive:true});
    await fs.writeFile(marker,JSON.stringify({sourceHash:hash(sourceCode)}));
    const blank=await chooseUpdateTargets(root,[binding],"empty");
    assert.equal(blank.targets.length,1);
    await applyPresetVersion(root, binding, installed[0], toolchain());
    const updated = await fs.readFile(source, "utf8");
    assert.match(updated, /\.accoding\/presets\/0\.2\.0\/expanded\.h/);
    assert.equal(updated.replace(/#include "[^"]+"/, '#include "exam.h"'), sourceCode);
    const second = await store.import({ ...problem, target: { kind: "problemset", problemId: "321" } }, "B-Test");
    await fs.writeFile(path.join(root, second.sourceFile), updated);
    await fs.rm(global, { recursive: true });
    await fs.rm(newGlobal, { recursive: true });
    await fs.rm(pkg, { recursive: true });
    const app = new StandaloneWorkflow();
    try {
      assert.deepEqual(await installedPresets(), []);
      assert.equal((await app.activePreset(undefined, root))?.manifest.id, preset.manifest.id);
      const left = await app.prepare(await app.resolve(source));
      const right = await app.prepare(await app.resolve(path.join(root, second.sourceFile)));
      assert.equal(left.code, right.code);
    } finally { app.dispose(); }
    assert.equal((await fs.readdir(path.join(root, ".accoding", "presets")))
      .filter((name) => name === "0.2.0").length, 1);
    await undoPresetUpdate(root, binding);
    const undone = await fs.readFile(source, "utf8");
    assert.match(undone, /\.accoding\/presets\/local-[a-f0-9]{64}\/expanded\.h/);
    assert.equal(undone.replace(/#include "[^"]+"/, '#include "exam.h"'), sourceCode);
  } finally {
    if (previousLegacyOnly === undefined) delete process.env.ACCODING_PRESET_LEGACY_ONLY;
    else process.env.ACCODING_PRESET_LEGACY_ONLY = previousLegacyOnly;
    if (previousPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousPrefix;
    if(previous===undefined)delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME=previous;
    await fs.rm(temp,{recursive:true,force:true});
  }
});

test("missing C99 package gives an actionable error while C++17 needs no preset", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-no-preset-"));
  const previous = process.env.XDG_DATA_HOME;
  const previousPrefix = process.env.npm_config_prefix;
  const previousLegacyOnly = process.env.ACCODING_PRESET_LEGACY_ONLY;
  process.env.ACCODING_PRESET_LEGACY_ONLY = "1";
  process.env.npm_config_prefix = path.join(temp, "npm global");
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
    if (previousLegacyOnly === undefined) delete process.env.ACCODING_PRESET_LEGACY_ONLY;
    else process.env.ACCODING_PRESET_LEGACY_ONLY = previousLegacyOnly;
    if (previousPrefix === undefined) delete process.env.npm_config_prefix;
    else process.env.npm_config_prefix = previousPrefix;
    if (previous === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("batch preset update uses source history and can recognize an unchanged generated template", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-update-"));
  try {
    await courseSettings(root, "c");
    const store = new WorkspaceStore(root);
    const preset = await loadPreset(path.resolve("scaffold/presets/example-c99"));
    const snapshot = await saveSharedPreset(root, preset, "0.6.5");
    const bindings = [];
    for (const [index, suffix] of ["", "// 已写代码\n"].entries()) {
      const binding = await store.import({
        ...problem, target: { kind: "problemset", problemId: String(index + 100) }
      }, "题目-" + index);
      const source = path.join(root, binding.sourceFile);
      await fs.writeFile(source,
        '#include "' + presetInclude(source, snapshot.directory) + '"\n' + cTemplate + suffix);
      bindings.push(binding);
    }
    const preview = await chooseUpdateTargets(root, bindings, "empty", [], "0.6.6");
    assert.deepEqual(preview.targets.map(b => b.bindingId), [bindings[0].bindingId]);
    assert.equal(preview.retained, 1);
    assert.deepEqual((await chooseUpdateTargets(root, bindings, "empty", [], "0.6.5")).targets, []);
    await assert.rejects(applyPresetVersion(root, bindings[1], { version: "0.6.6", preset },
      toolchain(), true), /源码已改动/);
    assert.match(await fs.readFile(path.join(root, bindings[1].sourceFile), "utf8"), /0\.6\.5/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("npm dependency is preferred over a legacy launcher's incompatible resource path", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-npm-priority-"));
  const previous = process.env.ACCODING_PRESET_PACKAGE;
  try {
    const example=path.resolve("scaffold/presets/example-c99");
    await fs.cp(example,path.join(temp,"preset"),{recursive:true});
    await fs.writeFile(path.join(temp,"package.json"),JSON.stringify({name:"@annouimo/c-exam-kit-preset",version:"0.7.0"}));
    process.env.ACCODING_PRESET_PACKAGE=temp;
    const found=await installedPresets();
    assert.equal(found.length,1);
    assert.match(found[0].version,/^0\.6\.(?:9|[1-9][0-9]+)$/);
  } finally {
    if (previous===undefined) delete process.env.ACCODING_PRESET_PACKAGE;
    else process.env.ACCODING_PRESET_PACKAGE=previous;
    await fs.rm(temp,{recursive:true,force:true});
  }
});
