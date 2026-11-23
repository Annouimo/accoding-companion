import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { StandaloneWorkflow } from "../../src/standalone/workflow";
import { StateStore, isAccepted, activityAccepted } from "../../src/standalone/state";
import { builtinPreset } from "../../src/standalone/generated-preset";
import { renderHeader } from "../../src/standalone/scaffold";
import { courseSettings } from "../../src/standalone/workspaces";

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
    for (const entry of preset.manifest.components)
      await fs.writeFile(path.join(config, entry.source), preset.code.get(entry.id)!);
    await fs.writeFile(path.join(config, "manifest.json"),
      JSON.stringify(preset.manifest));
    const expandedHeader = path.join(config, "expanded.h");
    await fs.writeFile(expandedHeader, renderHeader(preset));
    const relativeHeader = path.relative(folder, expandedHeader).split(path.sep).join("/");
    const wrapper = "#ifndef ACCODING_EXAM_WRAPPER_H\\n" +
      "#define ACCODING_EXAM_WRAPPER_H\\n" +
      '#include "' + relativeHeader + '"\\n#endif\\n';
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
    const resolved = await app.resolve(source);
    assert.equal(await app.test(resolved), true);
    assert.ok(app.testedCode(source)?.includes("static unsigned long long exam_lcm_u64"));
    const prepared = await app.prepare(resolved);
    assert.ok(!prepared.code.includes('#include "exam.h"'));
    await fs.writeFile(path.join(folder, "exam.h"), wrapper + "// changed");
    await assert.rejects(app.prepare(resolved), /exam.h 已被修改/);
    await fs.writeFile(path.join(folder, "exam.h"), wrapper);
    assert.notEqual(prepared.source, source);
    const firstBytes = await fs.readFile(prepared.source, "utf8");
    const originalBytes = await fs.readFile(source, "utf8");
    assert.equal(prepared.originalHash.length, 64);
    // A second editor task must not overwrite a snapshot used by the first one.
    await fs.writeFile(source, originalBytes.replace("12, 18", "15, 20"));
    const changed = await app.prepare(resolved);
    assert.notEqual(changed.source, prepared.source);
    assert.notEqual(changed.originalHash, prepared.originalHash);
    assert.equal(await fs.readFile(prepared.source, "utf8"), firstBytes);
    await fs.writeFile(source, originalBytes);
    const [repeat, concurrent] = await Promise.all([
      app.prepare(resolved), app.prepare(resolved)
    ]);
    assert.equal(repeat.source, prepared.source);
    assert.equal(concurrent.source, prepared.source);
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
    assert.notEqual(cppSnapshot.source, cpp);
    assert.equal(await fs.readFile(cppSnapshot.source, "utf8"), cppSnapshot.code);
  } finally {
    app.dispose();
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfig;
    await fs.rm(root, { recursive: true, force: true });
  }
});
