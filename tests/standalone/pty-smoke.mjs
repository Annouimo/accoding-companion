#!/usr/bin/env node
// Runs the built CLI in a real Linux pseudo-terminal, without an Accoding account.
// Regression: Ink unmount must not let Node exit before readline receives input.
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

await scenario("menu -> readline -> result -> menu -> exit", async ctx => {
  await ctx.expect("导入独立题目"); ctx.send("2");
  await ctx.expect("题目 ID 或链接");
  await delay(300);
  assert.ok(ctx.alive(), "regression: CLI exited while waiting for a problem ID");
  ctx.send("221\r");
  await ctx.expect("导入结果");
  await ctx.expect("返回");
  ctx.send("\r");
  await ctx.expect("导入独立题目");
  ctx.send("q");
});

await scenario("nested course setup -> C99 prompt -> back", async ctx => {
  await ctx.expect("设置 / 切换工作区"); ctx.send("3");
  await ctx.expect("选择 / 新建课程工作区"); ctx.send("\r");
  await ctx.expect("添加已有工作区 / 新建课程文件夹"); ctx.send("\r");
  await ctx.expect("课程文件夹"); ctx.send(path.join(ctx.home, "test-course") + "\r");
  await ctx.expect("选择固定编程语言"); ctx.send("1\r");
  await ctx.expect("操作结果"); ctx.send("\r");
  await ctx.expect("设置 / 切换工作区");
  const settings = JSON.parse(await fs.readFile(
    path.join(ctx.home, "test-course", ".accoding", "workspace.json"), "utf8"));
  assert.equal(settings.language, "c");
  ctx.send("q");
});
