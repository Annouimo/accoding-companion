#!/usr/bin/env node
// Runs the built CLI in a real Linux pseudo-terminal, without an Accoding account.
// Exercise navigation and inline input without submitting account credentials.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "linux") {
  console.log("PTY regression runs on Linux; skipping this platform.");
  process.exit(0);
}

const bundle = path.resolve(process.argv[2] || "dist/accoding.mjs");
await fs.access(bundle);

async function scenario(name, run, prepare) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-pty-"));
  const env = { ...process.env, HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CI: "false", TERM: "xterm-256color", NO_COLOR: "1",
    PATH: process.env.PATH };
  prepare?.(env);
  const command = (prepare ? "stty rows 16 cols 84; exec " : "") +
    JSON.stringify(process.execPath) + " " + JSON.stringify(bundle);
  const child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"],
    { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let cursor = 0;
  let finished = false;
  let code = null;
  child.stdout.on("data", part => output += part.toString());
  child.stderr.on("data", part => output += part.toString());
  child.on("close", value => { finished = true; code = value; });
  const tail = () => output.slice(-1600).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  async function expect(needle, timeout = 9000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const index = output.indexOf(needle, cursor);
      if (index >= 0) { cursor = index + needle.length; return; }
      if (finished) throw Error(name + ": exited " + code + " before " + needle + "\n" + tail());
      await delay(40);
    }
    throw Error(name + ": timed out waiting for " + needle + "\n" + tail());
  }
  function send(value) {
    assert.equal(finished, false, name + ": process already ended\n" + tail());
    child.stdin.write(value);
  }
  try {
    await run({ expect, send, home, alive: () => !finished });
    const deadline = Date.now() + 9000;
    while (!finished && Date.now() < deadline) await delay(40);
    assert.ok(finished, name + ": process did not finish\n" + tail());
    assert.equal(code, 0, name + ": process exited " + code + "\n" + tail());
    console.log("PASS " + name);
  } finally {
    if (!finished) child.kill("SIGTERM");
    child.stdin.end();
    await fs.rm(home, { recursive: true, force: true });
  }
}

await scenario("import opens the login form and can be cancelled", async ctx => {
  await ctx.expect("❯ 导入"); await delay(250); ctx.send("\x1b[A");
  await ctx.expect("❯ 设置"); ctx.send("\x1b[B");
  await ctx.expect("❯ 导入"); ctx.send("\r");
  await ctx.expect("导入比赛 / 作业"); ctx.send("\x1b[B");
  await ctx.expect("❯ 导入独立题目"); ctx.send("\r");
  await ctx.expect("登录 Accoding"); ctx.send("\x1b");
  await ctx.expect("❯ 导入"); await delay(250); ctx.send("q");
});

await scenario("nested course setup saves a C99 workspace", async ctx => {
  await ctx.expect("❯ 导入"); await delay(250); ctx.send("\x1b[B");
  await ctx.expect("❯ 设置"); ctx.send("\r");
  await ctx.expect("切换或新建课程"); ctx.send("\r");
  await ctx.expect("输入已有或新课程目录"); ctx.send("\r");
  await ctx.expect("课程目录（可粘贴或拖入路径）");
  const directory = path.join(ctx.home, "test-course");
  await fs.mkdir(directory);
  const existingCode = path.join(directory, "已有代码.c");
  await fs.writeFile(existingCode, "int main(void) { return 0; }\n");
  ctx.send(directory); await ctx.expect(directory); ctx.send("\r");
  await ctx.expect("选择课程的编程语言"); ctx.send("\r");
  await ctx.expect("test-course");
  const settings = JSON.parse(await fs.readFile(path.join(directory, ".accoding", "workspace.json"), "utf8"));
  assert.equal(settings.language, "c");
  assert.equal(await fs.readFile(existingCode, "utf8"), "int main(void) { return 0; }\n");
  await ctx.expect("H 手册");
  settings.presetVersion = "0.6.6";
  await fs.writeFile(path.join(directory, ".accoding", "workspace.json"), JSON.stringify(settings));
  const snapshot = path.join(directory, ".accoding", "presets", settings.presetVersion);
  await fs.mkdir(snapshot, { recursive: true });
  const manual = path.join(snapshot, "manual.zh-CN.md");
  await fs.writeFile(manual, "# 测试手册\n\n## 数组\n\n" +
    "读取数组。\n\n" + String.fromCharCode(96).repeat(3) + "c\n" +
    "int count = 2; // 示例\n" + String.fromCharCode(96).repeat(3) + "\n");
  ctx.send("h");
  await ctx.expect("C99 函数速查 · 0.6.6");
  await ctx.expect("❯ 数组"); await delay(150); ctx.send("\r");
  await ctx.expect("int count = 2; // 示例");
  await delay(150); ctx.send("\x1b"); await ctx.expect("❯ 数组");
  await delay(150); ctx.send("\x1b"); await ctx.expect("H 手册");
  ctx.send("q");
});

await scenario("sample table starts at the difference and scrolls within a 16-row terminal", async ctx => {
  await ctx.expect("❯ 运行样例");
  ctx.send("\r");
  await ctx.expect("输出不符");
  await ctx.expect("样例输出");
  await ctx.expect("〈输出已结束〉");
  await ctx.expect("显示 11–21 / 30");
  ctx.send("\x1b[C");
  await ctx.expect("RIGHT-END");
  ctx.send("\x1b[B");
  await ctx.expect("显示 12–22 / 30");
  ctx.send("]");
  await ctx.expect("通过 · 2/2");
  ctx.send("\x1b");
  await ctx.expect("本地样例 1/2 通过");
  ctx.send("q");
}, env => {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { WorkspaceStore } from "./src/workspace/store.ts";
    import { StateStore } from "./src/standalone/state.ts";
    import { courseSettings } from "./src/standalone/workspaces.ts";
    const root = path.join(process.env.HOME, "sample-course");
    await courseSettings(root, "c");
    const lines = Array.from({length: 30}, (_, i) => String(i + 1));
    lines[10] = "L".repeat(43) + "RIGHT-END";
    const output = lines.slice(0, 12).join("\\n") + "\\n";
    const workspace = new WorkspaceStore(root);
    await workspace.import({
      target: { kind: "problemset", problemId: "123" }, title: "样例表格", label: "A",
      statement: { format: "markdown", content: "", baseUrl: "https://accoding.buaa.edu.cn/" },
      languages: ["c"], warnings: [], special: false,
      samples: [
        { key: "first", input: "", expected: lines.join("\\n") + "\\n" },
        { key: "second", input: "", expected: output }
      ]
    });
    const binding = await workspace.read("problem-123");
    await fs.writeFile(path.join(root, binding.sourceFile),
      "#include <stdio.h>\\nint main(void) { fputs(" + JSON.stringify(output) + ", stdout); }\\n");
    const state = new StateStore();
    await state.rememberWorkspace(root);
    const saved = await state.load();
    saved.tuiPage = { root, group: "independent", problem: "problem-123" };
    await state.save(saved);
  `], { env, stdio: "inherit" });
});

await scenario("password form stays open until cancelled", async ctx => {
  await ctx.expect("❯ 导入"); await delay(250); ctx.send("\x1b[B");
  await ctx.expect("❯ 设置"); ctx.send("\r");
  await ctx.expect("切换或新建课程"); ctx.send("\x1b[B");
  await ctx.expect("❯ 登录 Accoding"); ctx.send("\r");
  await ctx.expect("登录 Accoding");
  ctx.send("fake-student"); await ctx.expect("fake-student"); ctx.send("\t");
  await ctx.expect("密码  ▏"); await delay(100); ctx.send("secret123"); await ctx.expect("•••••••••");
  await delay(250);
  assert.ok(ctx.alive(), "CLI exited while waiting for password input");
  ctx.send("\x1b");
  await ctx.expect("❯ 设置"); ctx.send("q");
});
