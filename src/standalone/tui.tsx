import { languageChoices } from "../workspace/sources";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StandaloneWorkflow, ResolvedProblem, SampleTestReport } from "./workflow";
import { activityAccepted, type ApplicationState } from "./state";
import { type UpdateMode } from "./preset-manager";
import { courseSettings, droppedPath } from "./workspaces";
import { SampleOutput } from "./sample-output";
import { Manual, parseReference } from "./manual";
import { LoginForm } from "./login-form";

type Page = { group?: string; problem?: string };
interface Row {
  id: string;
  label: string;
  run: () => void | Promise<void>;
  verdict?: string;
}
type Panel =
  | { title: string; rows: Row[]; note?: string; cancel?: () => void; toggle?: (id: string) => void; confirm?: () => void }
  | { title: string; input: (text: string) => void | Promise<void>; secret?: boolean; cancel?: () => void };
interface Group { id: string; title: string; problems: ResolvedProblem[] }

function groupProblems(problems: ResolvedProblem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const problem of problems) {
    const target = problem.binding.problem.target;
    const id = target.kind === "contest" ? target.contestId : "independent";
    const directory = path.relative(problem.root, path.dirname(problem.source)).split(path.sep);
    const title = id === "independent" ? "独立题目" :
      directory.length > 1 && directory[0] !== "contests" ? directory[0] : "比赛 " + id;
    const group = groups.get(id) ?? { id, title, problems: [] };
    group.problems.push(problem);
    groups.set(id, group);
  }
  for (const { problems } of groups.values())
    problems.sort((a, b) => {
      const left = a.binding.problem.target, right = b.binding.problem.target;
      if (left.kind === "contest" && right.kind === "contest") {
        const diff = (left.contestOrder ?? Infinity) - (right.contestOrder ?? Infinity);
        if (diff) return diff;
      }
      return a.binding.problem.label.localeCompare(b.binding.problem.label, "zh", { numeric: true });
    });
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, "zh", { numeric: true }));
}

function openFolder(source: string): Promise<void> {
  const command = process.platform === "win32" ? "explorer.exe" :
    process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path.dirname(source)], {
      detached: true, stdio: "ignore", windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function Screen({ app }: { app: StandaloneWorkflow }) {
  const { exit } = useApp();
  const { rows: height } = useWindowSize();
  const [state, setState] = useState<ApplicationState>();
  const [problems, setProblems] = useState<ResolvedProblem[]>([]);
  const [page, setPage] = useState<Page>({});
  const [panel, setPanel] = useState<Panel>();
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [pendingOnly, setPendingOnly] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState("正在打开工作区…");
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState<Record<string, SampleTestReport>>({});
  const [details, setDetails] = useState<SampleTestReport>();
  const [manual, setManual] = useState<{ version: string; markdown: string; reference?: ReturnType<typeof parseReference> }>();
  const [loginResume, setLoginResume] = useState<{ after?: () => void }>();
  const cursors = useRef(new Map<string, number>());
  const active = useRef(true);
  const locked = useRef(true);
  const root = state?.lastWorkspace;
  const groups = groupProblems(problems);
  const group = groups.find((entry) => entry.id === page.group);
  const problem = group?.problems.find((entry) => entry.binding.bindingId === page.problem);
  const account = app.session.user?.id ?? state?.lastAccount ?? "offline";
  const pageKey = JSON.stringify([root, group?.id, problem?.binding.bindingId]);
  const crumbLabels = [root ? path.basename(root) : "Accoding Companion"];
  if (group) crumbLabels.push(group.title);
  if (problem) crumbLabels.push(problem.binding.problem.label + " · " + problem.binding.problem.title);

  async function reload() {
    const data = await app.state.load();
    const directory = data.lastWorkspace;
    const ready = directory && await fs.stat(path.join(directory, ".accoding", "workspace.json"))
      .then(() => true, () => false);
    const entries = ready ? await app.list(directory) : [];
    if (active.current) { setState(data); setProblems(entries); }
    return { data, entries };
  }

  useEffect(() => {
    void (async () => {
      try {
        await app.account(false).catch(() => undefined);
        const { data, entries } = await reload();
        const saved = data.tuiPage;
        if (saved?.root === data.lastWorkspace) {
          setPage({ group: saved?.group, problem: saved?.problem });
        } else {
          const user = app.session.user?.id ?? data.lastAccount ?? "offline";
          const last = entries.find((entry) => app.state.isLastProblem(
            data, entry.root, entry.binding.bindingId, user));
          if (last) {
            const target = last.binding.problem.target;
            setPage({ group: target.kind === "contest" ? target.contestId : "independent",
              problem: last.binding.bindingId });
          }
        }
      } catch (error) { setMessage(String(error)); }
      finally { locked.current = false; setBusy(""); }
    })();
    return () => { active.current = false; };
  }, [app]);

  function go(next: Page, defaultCursor = 0) {
    cursors.current.set(pageKey, cursor);
    const key = JSON.stringify([root, next.group, next.problem]);
    setCursor(cursors.current.get(key) ?? defaultCursor);
    setPage(next);
    setPanel(undefined);
    setMessage("");
    setDetails(undefined);
  }

  function parent() {
    if (problem) go({ group: group!.id }, group!.problems.indexOf(problem));
    else if (group) go({}, groups.indexOf(group));
  }

  async function quit() {
    if (locked.current) return;
    locked.current = true;
    try {
      const data = await app.state.load();
      if (root && data.lastWorkspace === root) {
        data.tuiPage = { root, ...(group ? { group: group.id } : {}),
          ...(problem ? { problem: problem.binding.bindingId } : {}) };
        await app.state.save(data);
      }
    } finally { exit(); }
  }

  function open(next: Panel) {
    setInput("");
    setPanel(next);
  }

  function pick(title: string, choices: string[]): Promise<string | undefined> {
    return new Promise((resolve) => open({ title, cancel: () => resolve(undefined),
      rows: choices.map((choice) => ({
        id: choice, label: choice, run: () => { setPanel(undefined); resolve(choice); }
      })) }));
  }

  async function run<T>(label: string, operation: () => Promise<T>, log = true) {
    if (locked.current) return;
    locked.current = true;
    setPanel(undefined);
    setBusy(label);
    setMessage("");
    const output: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    const collect = (...args: unknown[]) => {
      output.push(args.map(String).join(" "));
      if (log) setMessage(output.slice(-3).join("\n"));
    };
    Object.assign(console, { log: collect, warn: collect, error: collect });
    try {
      const result = await operation();
      await reload();
      return { result, output: output.join("\n") };
    } catch (error) {
      collect(error instanceof Error ? error.message : String(error));
      setMessage(output.slice(-3).join("\n"));
      return { output: output.join("\n") };
    } finally {
      Object.assign(console, originals);
      locked.current = false;
      setBusy("");
    }
  }

  function login(after?: () => void) {
    setPanel(undefined);
    setMessage("");
    setLoginResume({ after });
  }

  function chooseWorkspace() {
    open({ title: "课程工作区", rows: [
      ...(state?.recentWorkspaces ?? []).map((directory) => ({
        id: directory, label: path.basename(directory), run: () => switchWorkspace(directory)
      })),
      { id: "new", label: "输入已有或新课程目录", run: () => open({
        title: "课程目录（可粘贴或拖入路径）", input: async (directory) => {
          if (directory.trim()) await switchWorkspace(directory.trim());
        }
      }) }
    ] });
  }

  async function switchWorkspace(directory: string) {
    const result = await run("正在打开工作区…", async () => {
      const selected = await workspaceLanguage(directory);
      if (selected === "cancel") return false;
      await app.courseRoot(directory, selected);
      return true;
    });
    if (result?.result) go({});
  }

  async function workspaceLanguage(directory: string): Promise<"c" | "cpp" | "cancel" | undefined> {
    const exists = await fs.stat(path.join(droppedPath(directory), ".accoding", "workspace.json"))
      .then(() => true, () => false);
    if (exists) return;
    const language = await pick("选择课程的编程语言", languageChoices.map(choice => choice.label));
    return languageChoices.find(choice => choice.label === language)?.value ?? "cancel";
  }

  function importPrompt(kind: "contest" | "problem") {
    if (!app.session.user) { login(() => importPrompt(kind)); return; }
    open({ title: kind === "contest" ? "比赛 ID" : "题目 ID 或链接",
      input: async (value) => {
        if (!value.trim()) return;
        await run("正在导入…", async () => {
          const directory = root ?? await new Promise<string | undefined>((resolve) =>
            open({ title: "课程目录（可粘贴或拖入路径）", input: (directory) => {
              setPanel(undefined); resolve(directory.trim() || undefined);
            }, cancel: () => resolve(undefined) }));
          if (!directory) return;
          const language = await workspaceLanguage(directory);
          if (language === "cancel") return;
          if (kind === "contest") await app.importContest(value.trim(), directory, undefined, language);
          else await app.importProblem(value.trim(), directory, undefined, language);
        });
      } });
  }

  function selectPresetProblems(): Promise<string[] | undefined> {
    const checked = new Set<string>();
    return new Promise((resolve) => {
      function toggle(id: string) {
        if (!checked.delete(id)) checked.add(id);
        draw();
      }
      function draw() {
        open({ title: "选择要更新的题目", cancel: () => resolve(undefined), toggle,
          note: "已选 " + checked.size + " 题 · 空格勾选 · Enter 确认",
          confirm: () => { setPanel(undefined); resolve([...checked]); }, rows: [
            ...groups.flatMap((entry) => entry.problems).filter((entry) =>
              entry.source.toLowerCase().endsWith(".c")).map((entry) => {
              const id = entry.binding.bindingId;
              return { id, label: (checked.has(id) ? "✓ " : "○ ") +
                entry.binding.problem.label + " · " + entry.binding.problem.title,
                run: () => {} };
            })
          ] });
      }
      draw();
    });
  }

  async function presets() {
    if (!root) return;
    await run("正在读取本机脚手架…", async () => {
      if ((await courseSettings(root)).language !== "c") throw Error("此课程使用 C++。");
      const versions = await app.installedPresetVersions();
      if (!versions.length) throw Error("尚未安装 C Exam Kit。请先运行启动器。");
      const version = versions.length === 1 ? versions[0].version :
        await pick("选择资源版本", versions.map(entry => entry.version));
      if (!version) return;
      const safe = "更新新题默认版本和未改动的旧题";
      const choose = problem ? "仅更新当前题" : "自选题目";
      const scope = await pick("选择资源更新范围", problem ? [choose, safe] : [safe, choose]);
      if (!scope) return;
      const mode: UpdateMode = scope === safe ? "empty" : "selected";
      const selected = mode === "selected" ? (problem
        ? [problem.binding.bindingId] : await selectPresetProblems()) : [];
      if (!selected) return;
      const preview = await app.previewPresetUpdate(version, mode, selected, root);
      if (mode === "selected" && !preview.targets.length) {
        console.log("没有需要更新的题目。");
        return;
      }
      const summary = (mode === "empty" ? "新题使用 " + version + " · " : "") +
        "更新 " + preview.targets.length + " 题 · 保留 " + preview.retained + " 题" +
        (preview.retained ? "（已改动 " + preview.edited + " · 无法确认 " + preview.unknown + "）" : "");
      if (await pick(summary, ["确认更新", "取消"]) !== "确认更新") return;
      const result = await app.updateQuestionPresets(version, mode, selected, root, mode === "empty");
      setTestResult({});
      console.log("更新 " + result.updated + " 道题");
      for (const error of result.errors) console.log(error);
    });
  }

  function configureCompiler() {
    open({ title: "设置编译器", rows: (["c", "cpp"] as const).map(language => ({
      id: language, label: (language === "c" ? "C" : "C++") + " · " +
        ((language === "c" ? state?.compilerC : state?.compilerCpp) || "系统默认"),
      run: () => open({ title: "编译器可执行文件路径（auto 恢复系统默认）", input: async value => {
        const executable = value.trim().replace(/^"(.*)"$/, "$1");
        if (executable) await run("正在保存…", () => app.setCompiler(language, executable === "auto" ? "" : executable));
      } })
    })) });
  }

  function settings() {
    open({ title: "课程设置", rows: [
      { id: "workspace", label: "切换或新建课程", run: chooseWorkspace },
      { id: "compiler", label: "设置 C / C++ 编译器", run: configureCompiler },
      ...(root ? [{ id: "preset", label: "更新课程资源", run: presets }] : []),
      { id: "login", label: app.session.user ? "切换账号" : "登录 Accoding", run: login },
      ...(app.session.user ? [{ id: "logout", label: "退出登录", run: async () => {
        await run("正在退出登录…", () => app.logout());
      } }] : [])
    ] });
  }

  async function test() {
    if (!problem) return;
    let report: SampleTestReport | undefined;
    const result = await run("正在运行样例…", () => app.test(problem, value => { report = value; }), false);
    if (!result) return;
    if (report) {
      const completed = report;
      setTestResult(all => ({ ...all, [problem.source]: completed }));
      if (result.result === true) setCursor(0);
      else setDetails(completed);
    } else {
      setTestResult(({ [problem.source]: _, ...all }) => all);
      setMessage(result.output.trim());
    }
  }

  async function submit(tested: boolean) {
    if (!problem) return;
    const code = tested ? app.testedCode(problem.source) : undefined;
    if (tested && code === undefined) { setMessage("请先重新运行样例。"); return; }
    await run("正在提交…", () => app.submit(problem, undefined, code,
      (choices, fallback) => pick(fallback ? "题库提交语言（不计入比赛）" : "提交语言", choices)));
  }

  function more() {
    if (!problem) return;
    open({ title: "本题操作", rows: [
      { id: "status", label: "刷新本题评测状态", run: async () => {
        await run("正在查询本题结果…", () => app.status(root, false, problem.binding.problem.target));
      } },
      { id: "direct", label: "跳过样例直接提交", run: () => open({
        title: "跳过样例并编译提交？", rows: [
          { id: "cancel", label: "取消", run: () => setPanel(undefined) },
          { id: "send", label: "确认提交", run: () => submit(false) }
        ]
      }) },
      ...(problem.source.toLowerCase().endsWith(".c") ? [
        { id: "preset", label: "更新本题资源", run: presets },
        { id: "undo", label: "撤销本题上次脚手架更新", run: async () => {
          await run("正在撤销…", () => app.undoQuestionPreset(problem.binding.bindingId, root));
        } }
      ] : [])
    ] });
  }

  const accepted = (entry: ResolvedProblem) => Boolean(state && root && activityAccepted(
    app.state.getActivity(state, root, entry.binding.bindingId, account)));
  const verdict = (entry: ResolvedProblem) => state && root
    ? app.state.getActivity(state, root, entry.binding.bindingId, account).verdict : undefined;
  const passed = problem && Boolean(app.testedCode(problem.source));
  const result = problem && testResult[problem.source];
  const onlyPending = group && pendingOnly[pageKey];

  function showManual() {
    void run("正在打开手册…", async () => {
      if (!root) throw new Error("请先配置 C 课程工作区。");
      const file = await app.presetManualPath(root, problem);
      const content = await fs.readFile(file, "utf8");
      const version = path.basename(path.dirname(file));
      if (path.basename(file) === "reference.json")
        setManual({ version, markdown: "", reference: parseReference(content) });
      else setManual({ version, markdown: content });
    });
  }
  const entries: Row[] = problem ? [
    ...(passed ? [{ id: "submit", label: "提交本次通过的版本", run: () => submit(true) }] : []),
    { id: "test", label: passed ? "重新运行样例" : "运行样例", run: test },
    { id: "open", label: "打开代码目录", run: async () => {
      try { await openFolder(problem.source); }
      catch (error) { setMessage(String(error)); }
    } },
    ...(result ? [{ id: "details", label: "查看测试详情", run: () => setDetails(result) }] : []),
    { id: "more", label: "本题其他操作", run: more }
  ] : group ? [
    ...group.problems.filter((entry) => !onlyPending || !accepted(entry)).map((entry) => ({
      id: entry.binding.bindingId,
      label: entry.binding.problem.label + " · " + entry.binding.problem.title,
      verdict: accepted(entry) ? "AC" : verdict(entry) || "未提交",
      run: () => go({ group: group.id, problem: entry.binding.bindingId })
    })),
    ...(group.problems.some(accepted) ? [{ id: "filter", label: onlyPending ? "显示全部题目" : "仅看未 AC",
      run: () => { setPendingOnly({ ...pendingOnly, [pageKey]: !onlyPending }); setCursor(0); } }] : []),
    { id: "sync", label: "同步本组", run: async () => {
      await run("正在同步…", () => app.sync(root, group.id));
    } }
  ] : [
    ...groups.map((entry) => ({ id: entry.id, label: entry.title + "   " +
      entry.problems.filter(accepted).length + "/" + entry.problems.length + " AC",
      run: () => go({ group: entry.id }) })),
    { id: "import", label: "导入", run: () => open({ title: "导入", rows: [
      { id: "contest", label: "导入比赛 / 作业", run: () => importPrompt("contest") },
      { id: "problem", label: "导入独立题目", run: () => importPrompt("problem") }
    ] }) },
    { id: "settings", label: "设置", run: settings }
  ];

  const [panelCursor, setPanelCursor] = useState(0);
  useEffect(() => setPanelCursor(0), [panel?.title]);
  const list = panel ? ("rows" in panel ? panel.rows : []) : entries;
  const selected = Math.min(panel ? panelCursor : cursor, Math.max(0, list.length - 1));
  const visibleCount = Math.max(3, height - 12);
  const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), list.length - visibleCount));
  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (panel) {
        panel.cancel?.();
        setPanel(undefined);
      } else if (!locked.current) void quit();
      else if (process.listenerCount("SIGINT")) process.emit("SIGINT");
      return;
    }
    if (busy && !panel) return;
    if (panel && "input" in panel) {
      if (key.escape) { panel.cancel?.(); setPanel(undefined); }
      else if (key.return) void panel.input(input);
      else if (key.backspace || key.delete) setInput([...input].slice(0, -1).join(""));
      else if (!key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow &&
          !key.leftArrow && !key.rightArrow && char) setInput(input + char.replace(/[\r\n]/g, ""));
      return;
    }
    if (key.escape) {
      if (panel) { panel.cancel?.(); setPanel(undefined); }
      else parent();
      return;
    }
    if (!panel && !key.ctrl && char === "q") { void quit(); return; }
    if (!panel && !key.ctrl && !key.meta && char.toLowerCase() === "h") {
      showManual();
      return;
    }
    if ((key.upArrow || key.downArrow) && list.length)
      (panel ? setPanelCursor : setCursor)(
        (selected + list.length + (key.upArrow ? -1 : 1)) % list.length);
    else if (key.return) {
      if (panel && "rows" in panel && panel.confirm) panel.confirm();
      else void list[selected]?.run();
    }
    else if (char === " " && panel && "rows" in panel && list[selected])
      panel.toggle?.(list[selected].id);
  }, { isActive: !details && !manual && !loginResume });

  if (manual) return <Manual {...manual} onBack={() => setManual(undefined)} />;
  if (loginResume) return <LoginForm canRemember={app.credentialBackend.persistent}
    cancel={() => setLoginResume(undefined)} submit={async (username, password, remember) => {
      const loginResult = await run("登录中…", async () => {
        await app.signIn(username, password, remember);
        return true;
      }, false);
      if (!loginResult?.result) return loginResult?.output || "登录失败，请重试。";
      setLoginResume(undefined);
      loginResume.after?.();
    }} />;
  if (details) return <SampleOutput report={details} onBack={() => setDetails(undefined)} />;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        {crumbLabels.map((label, index) => <Text key={index}>
          {index ? " › " : ""}<Text bold={index === crumbLabels.length - 1}>{label}</Text>
        </Text>)}
      </Box>
      {!panel && problem ? <Text dimColor>
        {path.basename(problem.source)} · OJ <Text color={accepted(problem) ? "green" : undefined}>
          {verdict(problem) ?? "未提交"}</Text>
      </Text> : null}
      {!panel && result ? <Text color={passed ? "green" : "red"}>
        {result.kind === "compile" ? "编译失败" :
          "本地样例 " + result.passed + "/" + result.total + " 通过"}
      </Text> : null}
      {message ? <Text>{message}</Text> : null}
      {busy && !panel ? <Text color="cyan">{busy}</Text> : null}
      {panel ? <Text bold>{panel.title}</Text> : null}
      {panel && "rows" in panel && panel.note ? <Text dimColor>{panel.note}</Text> : null}
      {panel && "input" in panel ? <Text color="cyan">{panel.secret ? "•".repeat([...input].length) : input}▏</Text> : null}
      {list.slice(start, start + visibleCount).map((row, index) =>
        <Text key={row.id} color={selected === start + index ? "cyan" : undefined}>
          {selected === start + index ? "❯ " : "  "}{row.label}
          {row.verdict ? <Text color={row.verdict === "AC" ? "green" : undefined}>   {row.verdict}</Text> : null}
        </Text>)}
      {!busy && list.length > visibleCount ? <Text dimColor>{selected + 1}/{list.length}</Text> : null}
      <Text dimColor>{panel && "input" in panel ? "Enter 确定 · Esc 取消" :
        panel ? "↑ ↓ 选择 · Enter 确定 · Esc 返回" :
        "↑ ↓ 选择 · Enter 打开 · " + (group ? "Esc 返回 · " : "") + "H 函数速查 · Q 退出"}</Text>
    </Box>
  );
}

export async function startFullScreenTui(app: StandaloneWorkflow): Promise<void> {
  const screen = render(<Screen app={app}/>, { exitOnCtrlC: false, patchConsole: false, alternateScreen: true });
  await screen.waitUntilExit();
}
