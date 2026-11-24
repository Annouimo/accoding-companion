import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceStore } from "../../src/workspace/store";
import { compile } from "../../src/judge/judge";
import { StandaloneWorkflow, toolchain } from "../../src/standalone/workflow";
import { StateStore, isAccepted, activityAccepted } from "../../src/standalone/state";
import { builtinPreset } from "../../src/standalone/generated-preset";
import { loadPreset, PRESET_MANUAL, renderHeader } from "../../src/standalone/scaffold";
import { presetInclude, saveSharedPreset } from "../../src/standalone/preset-manager";
import { courseSettings } from "../../src/standalone/workspaces";

test("manual follows the problem's offline snapshot and the course's default version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-manual-"));
  try {
    const app = new StandaloneWorkflow();
    const preset = await loadPreset(path.resolve(import.meta.dirname,
      "../../scaffold/presets/example-c99"));
    const old = await saveSharedPreset(root, preset, "0.6.5");
    const initial = await saveSharedPreset(root, preset, "0.6.6");
    const recent = await saveSharedPreset(root, { ...preset, manual: "# 0.6.6\n" }, "0.6.6");
    assert.equal(initial.directory, recent.directory);
    assert.equal((await loadPreset(recent.directory)).manual, "# 0.6.6\n");
    const config = await courseSettings(root, "c");
    await fs.writeFile(path.join(root, ".accoding", "workspace.json"),
      JSON.stringify({ ...config, presetVersion: "0.6.6" }));

    const workspace = new WorkspaceStore(root);
    for (const [id, snapshot] of [["123", old], ["124", recent]] as const) {
      await workspace.import({
        target: { kind: "problemset", problemId: id },
        title: "Offline " + id, label: "#" + id,
        statement: { format: "markdown", content: "", baseUrl: "https://accoding.buaa.edu.cn/" },
        languages: ["c"], samples: [], warnings: [], special: false
      });
      const source = path.join(root, "problems", id, "main.c");
      await fs.writeFile(source, '#include "' + presetInclude(source, snapshot.directory) + '"\n');
    }
    const oldProblem = await app.resolve(path.join(root, "problems", "123", "main.c"));
    const newProblem = await app.resolve(path.join(root, "problems", "124", "main.c"));
    const manual = path.join(recent.directory, PRESET_MANUAL);
    assert.equal(await app.presetManualPath(root), manual);
    assert.equal(await app.presetManualPath(root, newProblem), manual);
    await assert.rejects(app.presetManualPath(root, oldProblem), /0\.6\.5 没有本地函数手册/);
    await saveSharedPreset(root, { ...preset, manual: "# 0.6.5\n" }, "0.6.5");
    assert.equal(await fs.readFile(await app.presetManualPath(root, oldProblem), "utf8"), "# 0.6.5\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("state persists verdict per account and source path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-state-"));
  try {
    const state = new StateStore(path.join(root, "state.json"));
    await state.rememberProblem(root, "contest-123-1", "account-1", {
      verdict: "AC", sourceFile: path.join(root, "main.c")
    });
    const loaded = await state.load();
    assert.equal(isAccepted(state.getActivity(loaded, root, "contest-123-1", "account-1").verdict), true);
    assert.equal(isAccepted(state.getActivity(loaded, root, "contest-123-1", "account-2").verdict), false);
    assert.equal(state.isLastProblem(loaded, root, "contest-123-1", "account-1"), true);
    assert.equal(state.isLastProblem(loaded, root, "contest-123-2", "account-1"), false);
    await state.rememberProblem(root, "contest-123-1", "account-1", { verdict: "WA" });
    const updated = await state.load();
    assert.equal(activityAccepted(state.getActivity(updated, root, "contest-123-1", "account-1")), true);
    assert.equal(state.getActivity(updated, root, "contest-123-1", "account-1").verdict, "WA");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("standalone C and C++ judge share the same persisted official samples", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-workflow-"));
  const savedConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(root, "configuration");
  const app = new StandaloneWorkflow();
  try {
    await courseSettings(root, "c");
    const workspace = new WorkspaceStore(root);
    await workspace.import({
      target: { kind: "problemset", problemId: "123" },
      title: "Offline example",
      label: "#123",
      statement: {
        format: "html",
        content: "",
        baseUrl: "https://accoding.buaa.edu.cn/problem/123/index"
      },
      languages: ["c", "cpp"],
      samples: [{ key: "sample-1", input: "", expected: "36\n" }],
      warnings: [],
      special: false
    });
    const folder = path.join(root, "problems", "123");
    const config = path.join(root, ".accoding", "scaffold", "problem-123");
    await fs.mkdir(config, { recursive: true });
    const preset = builtinPreset();
    await fs.mkdir(path.join(config, "components"));
    for (const entry of preset.manifest.components) {
      assert.ok(entry.source);
      await fs.writeFile(path.join(config, entry.source), preset.code.get(entry.id)!);
    }
    await fs.writeFile(path.join(config, "manifest.json"),
      JSON.stringify(preset.manifest));
    const expandedHeader = path.join(config, "expanded.h");
    await fs.writeFile(expandedHeader, renderHeader(preset));
    const relativeHeader = path.relative(folder, expandedHeader).split(path.sep).join("/");
    const wrapper = "#ifndef ACCODING_EXAM_WRAPPER_H\n" +
      "#define ACCODING_EXAM_WRAPPER_H\n" +
      '#include "' + relativeHeader + '"\n#endif\n';
    await fs.writeFile(path.join(folder, "exam.h"), wrapper);
    const source = path.join(folder, "main.c");
    // The generated compile source is nested under .accoding/generated, but
    // relative file paths must still resolve in the real problem folder.
    await fs.writeFile(path.join(folder, "local-input.txt"), "available\n");
    await fs.writeFile(source,
      '#include <stdio.h>\n#include "exam.h"\n' +
      'int main(void) { FILE *f = fopen("local-input.txt", "r");' +
      ' if (!f) return 2; fclose(f);' +
      ' printf("%llu\\n", exam_lcm_u64(12, 18)); return 0; }\n');
    // The tiny visible wrapper must also work with ordinary IDE/GCC compilation,
    // independently of the submission assembler.
    const executable = path.join(folder, "local-program");
    execFileSync("cc", ["-std=c99", source, "-lm", "-o", executable], { cwd:folder });
    assert.equal(execFileSync(executable, { cwd:folder, encoding:"utf8" }), "36\n");

    const resolved = await app.resolve(source);
    assert.equal(await app.test(resolved), true);
    assert.ok(app.testedCode(source)?.includes("static unsigned long long exam_lcm_u64"));
    const prepared = await app.prepare(resolved);
    assert.ok(!prepared.code.includes('#include "exam.h"'));
    await fs.writeFile(path.join(folder, "exam.h"), wrapper + "// changed");
    await assert.rejects(app.prepare(resolved), /exam.h 已被修改/);
    await fs.writeFile(path.join(folder, "exam.h"), wrapper);
    assert.equal(prepared.source, source);
    const firstBytes = prepared.code;
    assert.ok(!firstBytes.includes("#line"));
    const compiled = await compile(source, firstBytes, toolchain());
    try {
      assert.equal(compiled.result.exitCode, 0);
      assert.equal(await fs.readFile(path.join(compiled.directory, "submit.c"), "utf8"), firstBytes);
    } finally {
      await fs.rm(compiled.directory, { recursive: true, force: true });
    }
    await assert.rejects(fs.stat(path.join(root, ".accoding", "snapshots")), { code: "ENOENT" });
    await assert.rejects(fs.stat(path.join(root, ".accoding", "runs")), { code: "ENOENT" });
    const originalBytes = await fs.readFile(source, "utf8");
    assert.equal(prepared.originalHash.length, 64);
    // A second editor task must not overwrite a snapshot used by the first one.
    await fs.writeFile(source, originalBytes.replace("12, 18", "15, 20"));
    const changed = await app.prepare(resolved);
    assert.notEqual(changed.code, prepared.code);
    assert.notEqual(changed.originalHash, prepared.originalHash);
    assert.equal(prepared.code, firstBytes);
    await fs.writeFile(source, originalBytes);
    const [repeat, concurrent] = await Promise.all([
      app.prepare(resolved), app.prepare(resolved)
    ]);
    assert.equal(repeat.code, prepared.code);
    assert.equal(concurrent.code, prepared.code);
    // A stale or outside-workspace source preference must not override
    // the validated source association in the binding.
    await app.state.rememberProblem(root, resolved.binding.bindingId, "offline",
      { sourceFile: path.join(root, "unrelated.c") });
    const candidates = await app.list(root);
    assert.equal(candidates.find((x) => x.binding.bindingId ===
      resolved.binding.bindingId)?.source, source);

    // Another course workspace may use C++17; the C99 course cannot.
    const cppRoot = path.join(root, "other-course");
    await fs.mkdir(cppRoot);
    await courseSettings(cppRoot, "cpp");
    const cppWorkspace = new WorkspaceStore(cppRoot);
    const cppBinding = await cppWorkspace.import({
      target: { kind: "problemset", problemId: "123" },
      title: "Offline example", label: "#123",
      statement: {format: "html", content: "",
        baseUrl:"https://accoding.buaa.edu.cn/problem/123/index"},
      languages: ["c","cpp"],
      samples: [{key:"sample-1",input:"",expected:"36\n"}],
      warnings: [], special: false
    });
    const cpp = path.join(cppRoot, cppBinding.sourceFile);
    await fs.writeFile(cpp,
      '#include <iostream>\nint main() { std::cout << 36 << "\n"; }\n'
        .replace('<< "\n"', '<< "\\n"'));
    const cppResolved = await app.resolve(cpp);
    assert.equal(await app.test(cppResolved), true);
    const cppSnapshot = await app.prepare(cppResolved);
    assert.ok(!cppSnapshot.code.includes("exam_lcm_u64"));
    assert.equal(cppSnapshot.source, cpp);
    assert.equal(await fs.readFile(cppSnapshot.source, "utf8"), cppSnapshot.code);
  } finally {
    app.dispose();
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
    await fs.rm(root, { recursive: true, force: true });
  }
});
