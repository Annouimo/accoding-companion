import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceStore } from "../../src/workspace/store";
import { StandaloneWorkflow } from "../../src/standalone/workflow";
import type { Problem } from "../../src/model";
import { StateStore, activityAccepted } from "../../src/standalone/state";
import { droppedPath, readableName, initializeFriendlyLayout,
  isFriendlyWorkspace, readableProblemDirectory, courseSettings,
  ensureContestDirectory } from "../../src/standalone/workspaces";

test("Finder dropped paths and Windows-safe user-facing names", () => {
  assert.equal(droppedPath("'~/C projects/示例'", "/tmp", "/Users/test"),
    path.resolve("/Users/test/C projects/示例"));
  assert.equal(droppedPath("~/C\\ projects/示例", "/tmp", "/Users/test"),
    path.resolve("/Users/test/C projects/示例"));
  assert.equal(readableName('A:字符/统计*?'), "A 字符 统计");
  assert.equal(readableName("CON"), "_CON");
  assert.equal(readableName("..."), "未命名");
});

test("new friendly workspace works and legacy sources are preserved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-friendly-"));
  try {
    assert.equal((await courseSettings(root, "c")).language, "c");
    assert.equal(await isFriendlyWorkspace(root), true);
    const store = new WorkspaceStore(root);
    const problem: Problem = {
      target: { kind: "problemset", problemId: "987654" },
      title: "数组/求和",
      label: "A",
      statement: { format: "html", content: "<p>Example</p>", baseUrl: "https://accoding.buaa.edu.cn" },
      languages: ["c", "cpp"], samples: [{ key: "sample-1", input: "1\n", expected: "1\n" }],
      warnings: [], special: false
    };
    const friendly = await readableProblemDirectory(root, problem);
    assert.equal(friendly, path.join("独立题目", "题目-数组 求和"));
    const entry = await store.import(problem, friendly);
    assert.equal(entry.sourceFile, friendly + "/main.c");
    assert.equal(entry.problemDirectory, friendly);
    assert.equal(await fs.readFile(path.join(root, friendly, "main.c"), "utf8").then(Boolean), true);
    assert.equal(entry.cases[0].input, "1\n");
    assert.equal(entry.problem.statement.content, "");
    assert.equal(entry.problem.samples.length, 0);
    assert.match(await fs.readFile(path.join(root, friendly, "题目.md"), "utf8"), /Example/);
    for (const artifact of ["cases", "problems", "index.json", "independent-folder.json"])
      await assert.rejects(fs.stat(path.join(root, ".accoding", artifact)), { code: "ENOENT" });
    assert.equal((await store.list())[0].problemDirectory, friendly);
    const app = new StandaloneWorkflow();
    try {
      assert.equal((await app.resolve(path.join(root, friendly, "main.c")))
        .binding.bindingId, entry.bindingId);
      const unrelated = path.join(root, friendly, "unrelated.c");
      await fs.writeFile(unrelated, "int main(void){return 0;}\n");
      await assert.rejects(app.resolve(unrelated), /当前文件不属于已初始化的题目/);
    } finally {
      app.dispose();
    }
    const another = await readableProblemDirectory(root, problem);
    assert.match(another, /987654$/);
    assert.equal(await initializeFriendlyLayout(root), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("legacy numeric layout never gets silently migrated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-legacy-"));
  try {
    await fs.mkdir(path.join(root, "contests", "123"), { recursive: true });
    await fs.mkdir(path.join(root, ".better-accoding"));
    assert.equal(await initializeFriendlyLayout(root), false);
    assert.equal(await isFriendlyWorkspace(root), false);
    await assert.rejects(courseSettings(root, "c"), /旧版工作区/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("admin-backed problem IDs remain indexable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-admin-"));
  try {
    await courseSettings(root, "c");
    const store = new WorkspaceStore(root);
    const admin: Problem = {
      target: { kind: "problemset", service: "admin", problemId: "12345" },
      title: "Administrator-backed exercise",
      label: "#12345",
      statement: { format: "html", content: "", baseUrl: "https://accoding.buaa.edu.cn:4000" },
      languages: ["c"], samples: [], warnings: [], special: false
    };
    const entry = await store.import(admin);
    assert.equal(entry.bindingId, "admin-problem-12345");
    assert.equal((await store.list())[0].bindingId, entry.bindingId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote verdict refresh does not change last-active problem", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-state-focus-"));
  try {
    const state = new StateStore(path.join(root, "user-state.json"));
    await state.rememberProblem(root, "contest-1-2", "user1");
    const first = await state.load();
    const activity = state.getActivity(first, root, "contest-1-2", "user1");
    await state.recordVerdict(root, "contest-1-1", "user1", "AC");
    const updated = await state.load();
    assert.equal(updated.lastProblem, first.lastProblem);
    assert.equal(state.getActivity(updated, root, "contest-1-2", "user1").lastActiveAt,
      activity.lastActiveAt);
    assert.equal(activityAccepted(state.getActivity(updated, root, "contest-1-1", "user1")), true);
    await state.recordVerdict(root, "contest-1-1", "user1", "WA");
    assert.equal(activityAccepted(state.getActivity(await state.load(), root,
      "contest-1-1", "user1")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("multiple contest directories never take over user folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-course-"));
  try {
    await courseSettings(root, "c");
    await fs.mkdir(path.join(root, "第五次作业"));
    const owned = await ensureContestDirectory(root, "77", "第五次作业");
    assert.equal(owned, "第五次作业-77");
    assert.equal(await ensureContestDirectory(root, "77", "改了名字"), owned);
    await assert.rejects(courseSettings(root, "cpp"), /固定使用/);
    assert.equal(await fs.stat(path.join(root, "第五次作业")).then(x=>x.isDirectory()),true);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

test("switching course roots restores that course's last active question", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-multi-course-"));
  try {
    const state = new StateStore(path.join(root, "state.json"));
    const c = path.join(root, "course-c");
    const cpp = path.join(root, "course-cpp");
    await state.rememberProblem(c, "contest-1-3", "student");
    await state.rememberProblem(cpp, "contest-2-7", "student");
    const saved = await state.load();
    assert.equal(state.isLastProblem(saved, c, "contest-1-3", "student"), true);
    assert.equal(state.isLastProblem(saved, cpp, "contest-2-7", "student"), true);
    assert.equal(state.isLastProblem(saved, c, "contest-1-1", "student"), false);
    assert.equal(saved.recentWorkspaces?.length, 2);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

test("legacy case edits are adopted into the compact binding without rewriting notes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-compact-"));
  try {
    await courseSettings(root, "c");
    const store = new WorkspaceStore(root);
    const statement = { format: "markdown" as const, content: "Official body", baseUrl: "" };
    const binding = await store.import({
      target: { kind: "problemset", problemId: "321" }, title: "Test", label: "A", statement,
      languages: ["c"], samples: [{ key: "sample-1", input: "1\n", expected: "2\n" }],
      warnings: [], special: false,
    });
    const notes = path.join(root, path.dirname(binding.sourceFile), "题目.md");
    await fs.writeFile(notes, "My notes\n");
    const file = path.join(root, ".accoding", "bindings", binding.bindingId + ".json");
    const test = binding.cases[0];
    const prefix = ".accoding/cases/" + binding.bindingId + "/" + test.id;
    const { hash } = await import("../../src/model");
    binding.problem.statement = statement;
    binding.problem.samples = [{ key: "sample-1", input: test.input, expected: test.expected }];
    test.baseline = { input: test.input, expected: test.expected };
    binding.fileHashes = { [prefix + ".in"]: hash(test.input), [prefix + ".out"]: hash(test.expected) };
    await fs.mkdir(path.dirname(path.join(root, prefix)), { recursive: true });
    await fs.writeFile(path.join(root, prefix + ".in"), "8\n");
    await fs.writeFile(path.join(root, prefix + ".out"), test.expected);
    await fs.writeFile(file, JSON.stringify(binding));
    const fresh = await new WorkspaceStore(root).read(binding.bindingId);
    assert.equal(fresh.cases[0].input, "8\n");
    assert.equal(fresh.cases[0].baseline?.input, "1\n");
    assert.equal(fresh.cases[0].locallyModified, true);
    assert.equal(fresh.fileHashes, undefined);
    assert.deepEqual(fresh.problem.samples, []);
    assert.equal(await fs.readFile(notes, "utf8"), "My notes\n");
    assert.equal(await fs.readFile(path.join(root, prefix + ".in"), "utf8"), "8\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
