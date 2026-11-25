#!/usr/bin/env node
// Runs the built CLI in a real Linux pseudo-terminal, without an Accoding account.
// Exercise navigation and inline input without submitting account credentials.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "linux") {
  console.log("PTY regression runs on Linux; skipping this platform.");
  process.exit(0);
}

const bundle = path.resolve(process.argv[2] || "dist/accoding.mjs");
await fs.access(bundle);

async function scenario(name, run, prepare, dimensions = "rows 16 cols 84") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-pty-"));
  const env = { ...process.env, HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CI: "false", TERM: "xterm-256color", NO_COLOR: "1",
    PATH: process.env.PATH };
  prepare?.(env);
  const command = (prepare ? 'tty > "$HOME/pty-device"; stty ' + dimensions + "; exec " : "") +
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
      const index = stripVTControlCharacters(output).indexOf(needle, cursor);
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
    await run({ expect, send, home, alive: () => !finished, resize: async (rows, cols) => {
      const device = (await fs.readFile(path.join(home,"pty-device"),"utf8")).trim();
      execFileSync("stty",["-F",device,"rows",String(rows),"cols",String(cols)]);
      await delay(200);
    } });
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
  await ctx.expect("H 函数速查");
  settings.presetVersion = "0.6.6";
  await fs.writeFile(path.join(directory, ".accoding", "workspace.json"), JSON.stringify(settings));
  const snapshot = path.join(directory, ".accoding", "presets", settings.presetVersion);
  await fs.mkdir(snapshot, { recursive: true });
  const manual = path.join(snapshot, "manual.zh-CN.md");
  await fs.writeFile(manual, "# 测试手册\n\n## 数组\n\n" +
    "读取数组。\n\n" + String.fromCharCode(96).repeat(3) + "c\n" +
    "int count = 2; // 示例\n" + String.fromCharCode(96).repeat(3) + "\n");
  ctx.send("h");
  await ctx.expect("C 函数速查 · 0.6.6");
  await ctx.expect("❯ 数组"); await delay(150); ctx.send("\r");
  await ctx.expect("int count = 2; // 示例");
  await delay(150); ctx.send("\x1b"); await ctx.expect("❯ 数组");
  await delay(150); ctx.send("\x1b"); await ctx.expect("H 函数速查");
  await fs.unlink(manual);
  await fs.writeFile(path.join(snapshot, "reference.json"), JSON.stringify({
    schemaVersion: 1, categories: [{title: "输入和输出", entries: [
      {id: "read_int", title: "读一个数", signatures: ["int read_int(void);", "long long read_ll(void);",
        "double read_double(void);"], description: "从标准输入读取一个数。", example: "int n = read_int();"}
    ]}]
  }));
  ctx.send("h"); await ctx.expect("❯ 输入和输出");
  await delay(150); ctx.send("\r"); await ctx.expect("❯ 读一个数");
  await delay(150); ctx.send("\r"); await ctx.expect("double read_double(void);");
  await ctx.expect("int n = read_int();");
  await delay(150); ctx.send("\x1b"); await ctx.expect("❯ 读一个数");
  await delay(150); ctx.send("\x1b"); await ctx.expect("❯ 输入和输出");
  await delay(150); ctx.send("\x1b"); await ctx.expect("H 函数速查");
  ctx.send("q");
});

await scenario("sample table starts at the difference and scrolls within a 16-row terminal", async ctx => {
  await ctx.expect("❯ 运行样例");
  ctx.send("\r");
  await ctx.expect("输出不符");
  await ctx.expect("样例输出");
  await ctx.expect("〈输出已结束〉");
  await ctx.expect("显示 11–19 / 30");
  ctx.send("\x1b[C");
  await ctx.expect("RIGHT-END");
  ctx.send("\x1b[B");
  await ctx.expect("显示 12–20 / 30");
  ctx.send("]");
  await ctx.expect("通过 · 2/2");
  ctx.send("\t"); await ctx.expect("警告 1/1"); await ctx.expect("未被使用");
  ctx.send("\r"); ctx.send("\x1b[F"); await ctx.expect("unused variable");
  ctx.send("\t"); await ctx.expect("stderr（不参与答案比较）"); await ctx.expect("trace sample");
  ctx.send("\t"); await ctx.expect("通过 · 2/2");
  ctx.send("["); await ctx.expect("显示 12–20 / 30");
  ctx.send("\x1b");
  await ctx.expect("本地样例 1/2 通过");
  ctx.send("q");
}, prepareSampleCourse);

function prepareSampleCourse(env) {
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import fs from "node:fs/promises";
    import path from "node:path";
import { stripVTControlCharacters } from "node:util";
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
      "#include <stdio.h>\\nint main(void) { int unused_index = 0; fputs(" + JSON.stringify(output) + ", stdout); fputs(\\"trace sample\\", stderr); }\\n");
    const state = new StateStore();
    await state.rememberWorkspace(root);
    const saved = await state.load();
    saved.tuiPage = { root, group: "independent", problem: "problem-123" };
    await state.save(saved);
  `], { env, stdio: "inherit" });
}

await scenario("missing compiler opens the local HTML guide only after a test request", async ctx => {
  await ctx.expect("❯ 运行样例");
  const marker = path.join(ctx.home, "compiler-guide-opened");
  await assert.rejects(fs.access(marker));
  ctx.send("\r");
  await ctx.expect("未找到 C 编译器");
  await ctx.expect("编译环境配置");
  for (let i = 0; i < 50; i++) {
    if (await fs.access(marker).then(() => true, () => false)) break;
    await delay(40);
  }
  const opened = (await fs.readFile(marker, "utf8")).trim();
  assert.equal(opened, path.resolve("docs/launcher/编译环境配置.html"));
  await fs.access(opened);
  ctx.send("q");
}, env => {
  prepareSampleCourse(env);
  env.ACCODING_CC = "accoding-test-nonexistent-compiler";
  env.PATH = env.HOME + path.delimiter + env.PATH;
  execFileSync("sh", ["-c", "cat > \"$HOME/xdg-open\"; chmod +x \"$HOME/xdg-open\""], {
    env, input: '#!/bin/sh\nprintf "%s\\n" "$1" >> "$HOME/compiler-guide-opened"\n'
  });
});


await scenario("structured manual supports variants, search, copy, resume and related navigation", async ctx => {
  await ctx.expect("❯ 运行样例");
  ctx.send("\x1b"); await ctx.expect("❯ A · 样例表格");
  ctx.send("\x1b"); await ctx.expect("❯ 独立题目");
  ctx.send("h"); await ctx.expect("❯ 输入与输出");
  ctx.send("\r"); await ctx.expect("❯ 数字读写");
  ctx.send("\r"); await ctx.expect("❯ 读一个数");
  await ctx.expect("用途"); await ctx.expect("读取一个数。");
  ctx.send("\r"); await ctx.expect("[int]"); await ctx.expect("函数接口"); await ctx.expect("使用说明");
  await ctx.expect("调用示例"); await ctx.expect("int x = read_int();");
  ctx.send("\t"); await ctx.expect("[long long]"); await ctx.expect("long long x = read_ll();");
  ctx.send("c"); await ctx.expect("已复制完整示例");
  assert.equal(await fs.readFile(path.join(ctx.home,"clipboard.txt"),"utf8"),"long long x = read_ll();");
  ctx.send("h"); await ctx.expect("❯ 独立题目");
  ctx.send("h"); await ctx.expect("[long long]"); await ctx.expect("long long x = read_ll();");
  ctx.send("/"); await ctx.expect("搜索：");
  ctx.send("read_double"); await ctx.expect("读一个数"); ctx.send("\r");
  await ctx.expect("[double]"); await ctx.expect("double x = read_double();");
  ctx.send("r"); await ctx.expect("❯ 读数组");
  ctx.send("\r"); await ctx.expect("读数组");
  ctx.send("\x1b[6~"); await ctx.expect("扩展接口 · 显式容量");
  await ctx.expect("read_ints_into(int *a, int n, size_t capacity);");
  ctx.send("\x1b"); await ctx.expect("[double]"); await ctx.expect("double x = read_double();");
  ctx.send("h"); await ctx.expect("❯ 独立题目"); ctx.send("q");
}, prepareReferenceCourse, "rows 20 cols 64");

function prepareReferenceCourse(env) {
  prepareSampleCourse(env);
  const reference={schemaVersion:1,notes:"## 开始使用\n保留题目原有头文件引用。\n\n## 下标与区间\n下标从零开始。",categories:[{title:"输入和输出",entries:[{
    id:"read_number",title:"读一个数",description:"读取一个数。",keywords:["数字","EOF"],
    signatures:["int read_int(void);","long long read_ll(void);","double read_double(void);"],example:"int x = read_int();",
    variants:[["int","int","read_int"],["ll","long long","read_ll"],["double","double","read_double"]].map(([key,label,name])=>({
      key,label,symbols:[name],signatures:[label+" "+name+"(void);"],example:label+" x = "+name+"();",note:""
    })),commonSignatures:[],related:["read_arrays"]
  },{id:"read_arrays",title:"读数组",description:"读取数组。",example:"int a[3]; read_ints(a, 3);",
      signatures:["read_ints(a, n)","void read_ints_into(int *a, int n, size_t capacity);"],
      advancedSignatures:["void read_ints_into(int *a, int n, size_t capacity);"],related:["read_number"]
  }]}],sections:[{title:"输入与输出",children:[{title:"数字读写",entries:["read_number"]},{title:"数组读写",entries:["read_arrays"]}]}]};
  execFileSync(process.execPath,["--input-type=module","-e",`
    import fs from "node:fs";
    import path from "node:path";
    const root=path.join(process.env.HOME,"sample-course");
    const settingsPath=path.join(root,".accoding","workspace.json");
    const settings=JSON.parse(fs.readFileSync(settingsPath,"utf8"));
    settings.presetVersion="0.6.7";
    fs.writeFileSync(settingsPath,JSON.stringify(settings));
    const dir=path.join(root,".accoding","presets","0.6.7");
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"reference.json"),process.env.TEST_REFERENCE);
  `],{env:{...env,TEST_REFERENCE:JSON.stringify(reference)}});
  env.PATH=env.HOME+path.delimiter+env.PATH;
  delete env.WAYLAND_DISPLAY;
  execFileSync("sh",["-c","cat > \"$HOME/xclip\"; chmod +x \"$HOME/xclip\""],{
    env,input:'#!/bin/sh\ncat > "$HOME/clipboard.txt"\n'
  });
}

await scenario("reference stays navigable in a narrow short terminal", async ctx => {
  await ctx.expect("❯ 运行样例");
  ctx.send("\x1b"); await ctx.expect("❯ A · 样例表格");
  ctx.send("\x1b"); await ctx.expect("❯ 独立题目");
  ctx.send("h"); await ctx.expect("分类目录"); await ctx.expect("❯ 输入与输出");
  await ctx.resize(12,38);
  ctx.send("\r"); await ctx.expect("❯ 数字读写");
  ctx.send("\r"); await ctx.expect("❯ 读一个数");
  ctx.send("\r"); await ctx.expect("[int]"); await ctx.expect("函数接口");
  ctx.send("\t"); await ctx.expect("[long long]");
  ctx.send("c"); await ctx.expect("已复制完整示例");
  assert.equal(await fs.readFile(path.join(ctx.home,"clipboard.txt"),"utf8"),"long long x = read_ll();");
  ctx.send("g"); await ctx.expect("分类目录"); await ctx.expect("❯ 输入与输出");
  ctx.send("u"); await ctx.expect("使用约定"); await ctx.expect("开始使用");
  await ctx.expect("下标与区间");
  ctx.send("g"); await ctx.expect("分类目录"); await ctx.expect("❯ 输入与输出");
  ctx.send("h"); await ctx.expect("❯ 独立题目"); ctx.send("q");
}, prepareReferenceCourse, "rows 20 cols 64");

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
