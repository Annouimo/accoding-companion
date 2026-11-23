#!/usr/bin/env node
// Runs the built CLI in a real Linux pseudo-terminal, without an Accoding account.
// Exercise navigation and inline input without submitting account credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

async function scenario(name, run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-pty-"));
  const env = { ...process.env, HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CI: "false", TERM: "xterm-256color", NO_COLOR: "1" };
  const command = JSON.stringify(process.execPath) + " " + JSON.stringify(bundle);
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
  await ctx.expect("❯ 导入"); ctx.send("\r");
  await ctx.expect("导入比赛 / 作业"); ctx.send("\x1b[B");
  await ctx.expect("❯ 导入独立题目"); ctx.send("\r");
  await ctx.expect("Accoding 账号"); ctx.send("\x1b");
  await ctx.expect("❯ 导入"); ctx.send("q");
});

await scenario("nested course setup saves a C99 workspace", async ctx => {
  await ctx.expect("❯ 导入"); ctx.send("\x1b[B");
  await ctx.expect("❯ 设置"); ctx.send("\r");
  await ctx.expect("切换或新建课程"); ctx.send("\r");
  await ctx.expect("输入已有或新课程目录"); ctx.send("\r");
  await ctx.expect("课程目录（可粘贴或拖入路径）");
  const directory = path.join(ctx.home, "test-course");
  ctx.send(directory); await ctx.expect(directory); ctx.send("\r");
  await ctx.expect("选择课程的编程语言"); ctx.send("\r");
  await ctx.expect("test-course");
  const settings = JSON.parse(await fs.readFile(path.join(directory, ".accoding", "workspace.json"), "utf8"));
  assert.equal(settings.language, "c");
  ctx.send("q");
});

await scenario("password form stays open until cancelled", async ctx => {
  await ctx.expect("❯ 导入"); ctx.send("\x1b[B");
  await ctx.expect("❯ 设置"); ctx.send("\r");
  await ctx.expect("切换或新建课程"); ctx.send("\x1b[B");
  await ctx.expect("❯ 登录 Accoding"); ctx.send("\r");
  await ctx.expect("Accoding 账号");
  ctx.send("fake-student"); await ctx.expect("fake-student"); ctx.send("\r");
  await ctx.expect("Accoding 密码");
  await delay(250);
  assert.ok(ctx.alive(), "CLI exited while waiting for password input");
  ctx.send("\x1b");
  await ctx.expect("❯ 设置"); ctx.send("q");
});
