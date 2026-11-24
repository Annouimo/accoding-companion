import fs from "node:fs/promises";
declare const __ACCODING_VERSION__: string;
import path from "node:path";
import { configDirectory } from "./state";
import { startFullScreenTui } from "./tui";
import { migrateLegacyWorkspace } from "./migrate";
import { spawn } from "node:child_process";
import { StandaloneWorkflow, type ResolvedProblem } from "./workflow";
import { ask, confirm, interactive, select } from "./terminal";
import { activityAccepted } from "./state";
import { compilerErrorMessage } from "./compiler-guide";

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error("缺少参数 " + name);
  return value;
}

function usage() {
  console.log([
    "Accoding TUI / CLI",
    "",
    "  accoding                         打开简洁 TUI",
    "  accoding login                   首次登录",
    "  accoding logout                  退出登录",
    "  accoding contest init ID|URL     初始化整场比赛",
    "  accoding problem init ID|URL     初始化单题",
    "  accoding test PATH               测试当前 C/C++ 源文件",
    "  accoding submit PATH             提交源文件",
    "  accoding file PATH               当前文件的简洁操作菜单",
    "  accoding status [--watch]        查询等待中的 OJ 评测",
    "  accoding sync                    手动同步题目与比赛",
    "  accoding config preset PATH      设置默认脚手架配置",
    "  accoding config paths            查看本机数据存储位置",
    "  accoding config compiler c PATH  设置 C 编译器路径",
    "  accoding config compiler cpp PATH 设置 C++ 编译器路径",
    "",
    "  --root DIR                       指定工作区（初始化/同步/查询）",
    "  --preset MANIFEST                初始化时使用自定义 C99 配置",
    "  --workspace-lang c|cpp           首次初始化课程工作区的固定语言",
    "  accoding resources update VERSION [--root DIR] [--preview]",
    "  accoding workspace migrate OLD --root NEW --workspace-lang c|cpp",
    "  --lang LANGUAGE                  指定 OJ 提交语言",
    "",
    "双击启动可进入 TUI。编辑器只需要 test 和 submit 两个命令。",
    "C 语言的单文件提交会按需展开 exam.h；C++ 不引入该函数库。"
  ].join("\n"));
}

async function runTest(app: StandaloneWorkflow, resolved: ResolvedProblem): Promise<boolean> {
  const passed = await app.test(resolved);
  if (passed && await confirm("所有本地样例通过。是否提交到 Accoding？")) {
    // Submit the immutable bytes that passed local testing.
    await app.submit(resolved, undefined, app.testedCode(resolved.source));
  }
  return passed;
}

async function openFolder(source: string): Promise<void> {
  const folder = path.dirname(source);
  const executable = process.platform === "win32" ? "explorer.exe" :
    process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(executable, [folder], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.once("error", (error) => console.error("无法打开文件夹：" + error.message));
  child.unref();
}

async function fileMenu(
  app: StandaloneWorkflow, problem: ResolvedProblem
): Promise<void> {
  for (;;) {
    const choice = await select(
      problem.binding.problem.label + " · " + problem.binding.problem.title +
        "\n源码：" + path.basename(problem.source),
      [
        { label: "测试（通过后询问是否提交）", value: "test" },
        { label: "直接提交", value: "submit" },
        { label: "打开代码文件夹", value: "folder" }
      ]
    );
    if (!choice) return;
    if (choice === "test") await runTest(app, problem);
    else if (choice === "submit") {
      if (await confirm("确认提交当前源文件？"))
        await app.submit(problem);
    } else if (choice === "folder") await openFolder(problem.source);
  }
}

async function chooseProblem(
  app: StandaloneWorkflow, onlyAccepted: boolean
): Promise<ResolvedProblem | undefined> {
  const items = await app.list();
  const state = await app.state.load();
  const account = app.session.user?.id ?? state.lastAccount ?? "offline";
  const relevant = items.filter((entry) =>
    activityAccepted(app.state.getActivity(state, entry.root, entry.binding.bindingId, account))
      === onlyAccepted);
  const selected = await select(onlyAccepted ? "已 AC 题目" : "尚未 AC 的题目",
    relevant.map((entry, index) => ({
      value: String(index),
      label: entry.binding.problem.label + " · " + entry.binding.problem.title +
        "  " +
        (app.state.getActivity(state, entry.root, entry.binding.bindingId, account)
          .verdict || "未提交")
    })));
  return selected === undefined ? undefined : relevant[Number(selected)];
}

async function tui(app: StandaloneWorkflow): Promise<void> {
  if (!interactive()) {
    usage();
    throw new Error("交互界面需要可输入的终端；自动化脚本请使用 CLI 子命令。");
  }
  let loggedIn: string | undefined;
  try {
    loggedIn = await app.account(false);
  } catch { /* Offline testing still works if a workspace is already available. */ }
  if (!loggedIn) {
    const first = await select("欢迎使用 Accoding。首次使用建议先登录。", [
      { label: "登录 Accoding", value: "login" },
      { label: "暂时跳过，使用已有本地工作区", value: "offline" }
    ]);
    if (first === "login") {
      try { await app.login(); }
      catch (error) {
        console.error("登录失败：" + (error instanceof Error ? error.message : String(error)));
        return;
      }
    }
    if (first === undefined) return;
  }

  let current: ResolvedProblem | undefined;
  for (;;) {
    const all = await app.list();
    const state = await app.state.load();
    const account = app.session.user?.id ?? state.lastAccount ?? "offline";
    const pending = all.filter((entry) => !activityAccepted(
      app.state.getActivity(state, entry.root, entry.binding.bindingId, account)
    ));
    const currentSolved = current && activityAccepted(app.state.getActivity(
      state, current.root, current.binding.bindingId, account));
    if (!current ||
        !all.some((item) => item.binding.bindingId === current!.binding.bindingId))
      current = pending[0];
    if (!current && all.length) console.log("\n当前工作区的题目均已 AC。");

    const title = current
      ? "当前题目：" + current.binding.problem.label + " · " +
          current.binding.problem.title + "\n源文件：" + current.source
      : "Accoding · 暂无进行中的题目";
    const choices = current
      ? [
          { label: "测试（全部通过后询问是否提交）", value: "test" },
          { label: "切换题目", value: "choose" },
          { label: "更多操作", value: "more" }
        ]
      : [
          { label: "开始一场比赛", value: "contest" },
          { label: "导入一道题目", value: "problem" },
          { label: "更多操作", value: "more" }
        ];
    const action = await select(title, choices);
    if (action === undefined) return;
    try {
    if (action === "test" && current) await runTest(app, current);
    if (action === "choose") {
      const picked = await chooseProblem(app, false);
      if (picked) {
        current = picked;
        const lastAccount = app.session.user?.id ??
          (await app.state.load()).lastAccount ?? "offline";
        await app.state.rememberProblem(
          current.root, current.binding.bindingId, lastAccount,
          { sourceFile: current.source }
        );
      }
    }
    if (action === "contest") {
      const id = await ask("比赛 ID 或链接");
      if (id) {
        await app.importContest(id);
        current = undefined;
      }
    }
    if (action === "problem") {
      const id = await ask("题目 ID 或链接");
      if (id) {
        await app.importProblem(id);
        current = undefined;
      }
    }
    if (action === "more") {
      const extra = await select("更多操作", [
        { label: "直接提交当前题目（跳过本地测试）", value: "submit" },
        { label: "开始新比赛", value: "contest" },
        { label: "导入单题", value: "problem" },
        { label: "查看已 AC 题目", value: "accepted" },
        { label: "手动同步比赛与题目", value: "sync" },
        { label: "切换工作区目录", value: "workspace" },
        { label: "设置脚手架配置", value: "preset" },
        { label: "查看本机数据存储位置", value: "paths" },
        { label: "设置 C / C++ 编译器", value: "compiler" },
        { label: "查看待查询的 OJ 提交", value: "status" },
        { label: "打开当前题目的文件夹", value: "folder" },
        { label: "登录 / 切换账号", value: "login" },
        { label: "退出登录", value: "logout" }
      ]);
      if (extra === "submit" && current) {
        if (await confirm("确认跳过样例检查，直接编译并提交当前源文件？"))
          await app.submit(current);
      } else if (extra === "contest") {
        const id = await ask("比赛 ID 或链接");
        if (id) { await app.importContest(id); current = undefined; }
      } else if (extra === "problem") {
        const id = await ask("题目 ID 或链接");
        if (id) { await app.importProblem(id); current = undefined; }
      } else if (extra === "accepted") {
        const picked = await chooseProblem(app, true);
        if (picked) await fileMenu(app, picked);
      } else if (extra === "sync") await app.sync();
      else if (extra === "workspace") {
        const currentRoot = (await app.state.load()).lastWorkspace || process.cwd();
        const directory = await ask("工作区目录", currentRoot);
        if (directory) { await app.workspaceRoot(directory); current = undefined; }
      } else if (extra === "compiler") {
        const state = await app.state.load();
        const selected = await select("选择要设置的编译器", [
          { label: "C（当前：" + (state.compilerC || "系统默认") + "）", value: "c" },
          { label: "C++（当前：" + (state.compilerCpp || "系统默认") + "）", value: "cpp" }
        ]);
        if (selected) {
          const previous = selected === "c" ? state.compilerC : state.compilerCpp;
          const compiler = await ask("编译器可执行文件路径（输入 auto 恢复系统默认）",
            previous || "auto");
          await app.setCompiler(selected as "c" | "cpp", compiler === "auto" ? "" : compiler);
        }
      } else if (extra === "preset") {
        const state = await app.state.load();
        console.log("将 c-exam-kit 的配置文件夹拖入终端，或粘贴 manifest.json 的路径。");
        console.log("当前配置：" + (state.presetPath || "内置示例"));
        const entry = await ask("脚手架目录或 manifest.json（default 恢复内置）",
          state.presetPath || "default");
        await app.setPreset(entry === "default" ? undefined : entry);
      } else if (extra === "paths") {
        await showPaths(app);
      }
      else if (extra === "status") await app.status(undefined, true);
      else if (extra === "folder" && current) await openFolder(current.source);
      else if (extra === "login") await app.login();
      else if (extra === "logout") await app.logout();
    }
    } catch (error) {
      console.error("操作失败：" + await compilerErrorMessage(error));
    }
  }
}

async function showPaths(app: StandaloneWorkflow): Promise<void> {
  const state = await app.state.load();
  console.log("普通设置：" + path.join(configDirectory(), "state.json"));
  console.log("登录凭据：" + app.credentialBackend.description +
    "（Cookie 与记住的密码不放入工作区）");
  console.log("当前工作区：" + (state.lastWorkspace || "尚未选择"));
  if (state.lastWorkspace) {
    console.log("题目元数据：" + path.join(state.lastWorkspace, ".accoding"));
    console.log("提交状态：" + path.join(state.lastWorkspace, ".accoding", "submissions"));
    console.log("脚手架快照：工作区 .accoding/scaffold/");
  }
  console.log("当前默认脚手架：" + (state.presetPath || "内置示例"));
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-V")) {
    console.log(__ACCODING_VERSION__); return;
  }
  if (args.includes("--help") || args.includes("-h")) { usage(); return; }
  const app = new StandaloneWorkflow();
  try {
    const root = option(args, "--root");
    const preset = option(args, "--preset");
    const lang = option(args, "--lang");
    const language = option(args, "--workspace-lang");
    if (language && !["c", "cpp"].includes(language))
      throw new Error("--workspace-lang 只支持 c 或 cpp。");
    const command = args[0];
    if (!command) {
      if (interactive() && (process.stdout.columns || 80) >= 60 &&
          process.env.ACCODING_CLASSIC_TUI !== "1")
        await startFullScreenTui(app);
      else await tui(app);
      return;
    }
    if (command === "login") { await app.login(); return; }
    if (command === "logout") { await app.logout(); return; }
    if (command === "contest" && args[1] === "init" && args[2]) {
      await app.importContest(args[2], root, preset, language as "c" | "cpp" | undefined);
      return;
    }
    if (command === "problem" && args[1] === "init" && args[2]) {
      await app.importProblem(args[2], root, preset, language as "c" | "cpp" | undefined);
      return;
    }
    if (command === "test" && args[1]) {
      const passed = await runTest(app, await app.resolve(args[1]));
      if (!passed) process.exitCode = 1;
      return;
    }
    if (command === "submit" && args[1]) {
      await app.submit(await app.resolve(args[1]), lang);
      return;
    }
    if (command === "file" && args[1]) {
      await fileMenu(app, await app.resolve(args[1]));
      return;
    }
    if (command === "resources" && args[1] === "update" && args[2]) {
      if (args.includes("--preview")) {
        const preview = await app.previewPresetUpdate(args[2], "empty", [], root);
        console.log(JSON.stringify({ root: preview.root, version: args[2],
          eligible: preview.targets.length, retained: preview.retained,
          edited: preview.edited, unknown: preview.unknown }));
        return;
      }
      const result = await app.updateQuestionPresets(args[2], "empty", [], root, true);
      console.log("新题默认资源 " + args[2] + " · 已更新 " + result.updated + " 题 · 保留 " + result.retained + " 题");
      for (const error of result.errors) console.error(error);
      if (result.errors.length) process.exitCode = 1;
      return;
    }
    if (command === "workspace" && args[1] === "migrate" && args[2]) {
      if (!root || (language !== "c" && language !== "cpp"))
        throw new Error("迁移需要 --root NEW 和 --workspace-lang c|cpp。");
      const report = await migrateLegacyWorkspace(args[2], root, language);
      console.log("成功迁移题目：" + report.migrated);
      for (const item of report.skipped) console.warn("未迁移：" + item);
      if (report.skipped.length) process.exitCode = 1;
      return;
    }
    if (command === "sync") { await app.sync(root); return; }
    if (command === "config" && args[1] === "paths") {
      await showPaths(app);
      return;
    }
    if (command === "config" && args[1] === "preset" && args[2]) {
      await app.setPreset(args[2] === "default" ? undefined : args[2]);
      return;
    }
    if (command === "config" && args[1] === "compiler" &&
        (args[2] === "c" || args[2] === "cpp") && args[3]) {
      await app.setCompiler(args[2], args[3] === "auto" ? "" : args[3]);
      return;
    }
    if (command === "status") { await app.status(root, args.includes("--watch")); return; }
    usage();
    throw new Error("不支持的命令。");
  } finally {
    app.dispose();
  }
}

run().catch(async (error: unknown) => {
  console.error("错误：" + await compilerErrorMessage(error));
  process.exitCode = 1;
});
