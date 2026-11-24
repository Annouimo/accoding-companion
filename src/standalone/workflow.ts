import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AccountSession } from "../auth/session";
import { login, currentUser, ContestAdapter, ProblemsetAdapter } from "../accoding/adapters";
import { fetchContestSnapshotForImport } from "../accoding/import";
import { syncContest } from "../workspace/contest";
import { WorkspaceStore } from "../workspace/store";
import { atomicWrite, safePath } from "../workspace/fs";
import { defaultSourceFiles, cTemplate, cppTemplate, languages } from "../workspace/sources";
import { compile, judge, type CaseResult, type JudgeResult, type Toolchain } from "../judge/judge";
import { sendSubmission } from "../submissions/send";
import { SubmissionStore, isPending } from "../submissions/store";
import { monitorSubmissions } from "../submissions/monitor";
import { bindingId, hash, parseImport, type Binding, type Comparison, type Problem, type Target } from "../model";
import { assembleC, loadPreset, quotedIncludes, stripSourceComments, PRESET_MANUAL, PRESET_REFERENCE, type LoadedPreset } from "./scaffold";
import { readableStatement } from "../problems/statement";
import { StateStore, isAccepted, activityAccepted } from "./state";
import { installedPresets, presetForVersion, setCoursePresetVersion,
  chooseUpdateTargets, applyPresetVersion, undoPresetUpdate, saveSharedPreset,
  sharedPresetPath, sharedInclude, presetInclude,
  type UpdateMode } from "./preset-manager";
import { credentialsBackend } from "./secrets";
import { ask, confirm, interactive, select, password } from "./terminal";
import { selectCourseDirectory, courseSettings, ensureContestDirectory, isFriendlyWorkspace, readableProblemDirectory, droppedPath } from "./workspaces";

export interface ResolvedProblem {
  root: string;
  workspace: WorkspaceStore;
  binding: Binding;
  source: string;
}

export type SampleCaseReport = CaseResult & {
  name: string;
  expected?: string;
  comparison: Comparison;
};

export type SampleTestReport =
  | { kind: "compile"; output: JudgeResult["compilation"] }
  | { kind: "samples"; cases: SampleCaseReport[]; passed: number; total: number };

export function toolchain(config: { c?: string; cpp?: string } = {}): Toolchain {
  const c = process.env.ACCODING_CC || process.env.CC || config.c;
  const cpp = process.env.ACCODING_CXX || process.env.CXX || config.cpp;
  return {
    c: c || process.env.ACCODING_MANAGED_CC ||
      (process.platform === "win32" ? "gcc" : "cc"),
    cpp: cpp || process.env.ACCODING_MANAGED_CXX ||
      (process.platform === "win32" ? "g++" : "c++"),
    cArgs: ["-std=" + languages.c.standard, "-O2", "-Wall", "-Wextra", "-Wno-unused-function"],
    cppArgs: ["-std=" + languages.cpp.standard, "-O2", "-Wall", "-Wextra"],
    cLinkArgs: ["-lm"],
    timeoutMs: 2000,
    outputLimit: 4 * 1024 * 1024
  };
}

function localPath(root: string, relative: string): string {
  const result = path.resolve(root, relative);
  const fromRoot = path.relative(root, result);
  if (fromRoot === ".." || fromRoot.startsWith(".." + path.sep) ||
      path.isAbsolute(fromRoot))
    throw new Error("Source path is outside the workspace.");
  return result;
}

async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sourceFor(binding: Binding, root: string): string {
  return localPath(root, binding.sourceFile);
}

export function submissionLanguageChoices(problem: Problem, source: string): string[] {
  const isC = path.extname(source).toLowerCase() === ".c";
  return problem.languages.filter((value) => {
    const normalized = value.toLowerCase().replace(/\s+/g, "");
    const cpp = /cpp|c\+\+|g\+\+|clang\+\+|^gnu\+\+/.test(normalized);
    if (!isC) return cpp;
    return !cpp && (/^c(?:\d|$)|gcc|clang|gnu99|gnu11|gnu17/.test(normalized));
  });
}

export class StandaloneWorkflow {
  readonly state = new StateStore();
  readonly credentialBackend = credentialsBackend();
  readonly session = new AccountSession(this.credentialBackend.store);
  private restored = false;
  private tested = new Map<string, { code: string; stamp: string }>();

  async account(required = true): Promise<string | undefined> {
    if (!this.restored) {
      this.restored = true;
      try {
        await this.session.restore();
      } catch (error) {
        this.restored = false;
        if (required) throw error;
      }
    }
    if (required) {
      const user = await this.session.ensure();
      if (!user) throw new Error("尚未登录 Accoding。请先运行 accoding login。");
      return user.id;
    }
    return this.session.user?.id;
  }

  async login(): Promise<void> {
    if (!interactive()) throw new Error("登录需要交互式终端，以免在命令行参数中泄露密码。");
    const username = await ask("Accoding 账号");
    if (!username) throw new Error("账号不能为空。");
    const pass = await password("Accoding 密码");
    if (!pass) throw new Error("密码不能为空。");
    const remember = this.credentialBackend.persistent
      ? await confirm("保持登录并将凭据保存在系统安全存储中？选择“否”仅本次运行有效", true)
      : false;
    await this.signIn(username, pass, remember);
  }

  async signIn(username: string, pass: string, remember: boolean): Promise<void> {
    remember = remember && this.credentialBackend.persistent;
    await this.credentialBackend.setSessionOnly(!remember);
    const user = await this.session.signIn({ username, password: pass }, remember);
    this.restored = true;
    const state = await this.state.load();
    state.lastAccount = user.id;
    await this.state.save(state);
    console.log("已登录 Accoding。账号 ID：" + user.id);
    if (!this.credentialBackend.persistent)
      console.log("当前平台仅支持会话内凭据，不会保存密码。");
  }

  async logout(): Promise<void> {
    await this.session.logout();
    this.restored = true;
    console.log("已退出登录并清除已保存的会话凭据。");
  }

  async courseRoot(explicit?: string, language?: "c" | "cpp"): Promise<string> {
    const saved = (await this.state.load()).lastWorkspace;
    const selected = await selectCourseDirectory(saved, explicit);
    const root = droppedPath(selected);
    await fs.mkdir(root, { recursive: true });
    const wasConfigured = await fileExists(path.join(root, ".accoding", "workspace.json"));
    const config = await courseSettings(root, language);
    // A newly created C99 workspace inherits the newest already installed
    // preset. Never silently change the preset of an existing course.
    if ((!wasConfigured || !config.presetVersion) && config.language === "c") {
      const versions = await installedPresets();
      if (versions.length) await setCoursePresetVersion(root, versions[0].version);
    }
    await this.state.rememberWorkspace(root);
    return root;
  }

  async workspaceRoot(explicit?: string): Promise<string> {
    const saved = await this.state.load();
    const root = droppedPath(explicit || saved.lastWorkspace ||
      path.join(os.homedir(), "Accoding"));
    await fs.mkdir(root, { recursive: true });
    await this.state.rememberWorkspace(root);
    return root;
  }

  private async ensureScaffold(root: string, binding: Binding, preset?: LoadedPreset, version?: string): Promise<void> {
    // C++ workspaces never receive the C99 exam library.
    const config = await courseSettings(root);
    if (config.language !== "c") return;
    if (!preset) throw new Error("C 课程缺少 C Exam Kit，请先安装数据包并选择课程脚手架版本。");
    const source = sourceFor(binding, root);
    if (await fs.readFile(source, "utf8") !== cTemplate) return;
    const legacy = path.join(root, ".accoding", "scaffold", binding.bindingId, "manifest.json");
    if (await fileExists(legacy)) return;
    const include = presetInclude(source, (await saveSharedPreset(root, preset, version)).directory);
    if (await fs.readFile(source, "utf8") === cTemplate)
      await atomicWrite(source, '#include "' + include + '"\n' + cTemplate);
  }

  private async ensureStatement(root: string, binding: Binding): Promise<void> {
    const folder = path.dirname(sourceFor(binding, root));
    const source = sourceFor(binding, root);
    const currentCode = await fs.readFile(source, "utf8");
    const starter = currentCode === cTemplate || currentCode === cppTemplate ||
      (currentCode.endsWith(cTemplate) && Boolean(sharedInclude(root, source, currentCode)));
    if (starter && !binding.initialSourceHash)
      await new WorkspaceStore(root).update(binding.bindingId, binding.revision,
        (entry) => { entry.initialSourceHash ??= hash(currentCode); });
    const readable = path.join(folder, "题目.md");
    try {
      await fs.writeFile(readable, readableStatement(binding.problem),
        { encoding: "utf8", flag: "wx" });
    } catch (error) {
      // User-owned notes are never overwritten, including on a remote sync.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  async configuredToolchain(): Promise<Toolchain> {
    const state = await this.state.load();
    return toolchain({ c: state.compilerC, cpp: state.compilerCpp });
  }

  async setCompiler(language: "c" | "cpp", executable: string): Promise<void> {
    await this.state.rememberCompiler(language, executable.trim());
    console.log((language === "c" ? "C" : "C++") +
      " 编译器：" + (executable.trim() || "自动检测"));
  }

  async presetManualPath(root: string, problem?: ResolvedProblem): Promise<string> {
    let directory: string;
    let version: string;
    if (problem) {
      if (path.extname(problem.source).toLowerCase() !== ".c")
        throw new Error("此题不使用 C 脚手架。");
      const code = await fs.readFile(problem.source, "utf8");
      const shared = sharedInclude(root, problem.source, code);
      if (shared) {
        version = shared.key;
        directory = await sharedPresetPath(root, version);
      } else {
        directory = await safePath(root, ".accoding/scaffold/" + problem.binding.bindingId);
        if (!(await fileExists(path.join(directory, "manifest.json"))))
          throw new Error("此题未引用工作区中的 C 脚手架。");
        version = "旧版快照（版本未知）";
      }
    } else {
      if (!(await fileExists(path.join(root, ".accoding", "workspace.json"))))
        throw new Error("请先配置 C 课程工作区。");
      const config = await courseSettings(root);
      if (config.language !== "c") throw new Error("此工作区不使用 C 脚手架。");
      if (!config.presetVersion) throw new Error("请先在设置中选择课程脚手架版本。");
      version = config.presetVersion;
      directory = await sharedPresetPath(root, version);
    }
    for (const filename of [PRESET_REFERENCE, PRESET_MANUAL]) {
      const artifact = await safePath(directory, filename);
      if (await fs.lstat(artifact).then(stat => stat.isFile(), error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      })) return artifact;
    }
    throw new Error("脚手架 " + version + " 没有本地函数手册。");
  }

  async activePreset(explicit?: string, root?: string): Promise<LoadedPreset | undefined> {
    // A C++17 course must not require a C99-only data package.
    if (root) {
      const config = await courseSettings(root);
      if (config.language === "cpp") return undefined;
    }
    if (explicit) return loadPreset(explicit);
    if (root) {
      const config = await courseSettings(root);
      if (config.presetVersion) {
        const shared = await sharedPresetPath(root, config.presetVersion);
        if (await fileExists(path.join(shared, "manifest.json"))) return loadPreset(shared);
        const found = await presetForVersion(config.presetVersion);
        return found.preset;
      }
    }
    const global = (await this.state.load()).presetPath;
    if (global) return loadPreset(global);
    // No silent fallback to the old GCD/LCM demonstration header.
    throw new Error("此 C 课程尚未配置正式 C Exam Kit。请先运行 npm install -g @annouimo/c-exam-kit-preset，再在“设置 → 更新课程资源”中设为课程默认版本。");
  }

  async setPreset(file?: string): Promise<void> {
    const selected = file ? droppedPath(file) : undefined;
    if (selected) {
      const preset = await loadPreset(selected);
      console.log("脚手架配置：" + preset.manifest.id +
        "，共 " + preset.manifest.components.length + " 个组件。");
    }
    await this.state.rememberPreset(selected);
  }

  async installedPresetVersions() {
    return installedPresets();
  }

  async setWorkspacePreset(version: string, rootArg?: string): Promise<void> {
    const root = await this.workspaceRoot(rootArg);
    await setCoursePresetVersion(root, version);
  }

  async previewPresetUpdate(version: string, mode: UpdateMode, selected: string[] = [], rootArg?: string) {
    const configured = rootArg ?? (await this.state.load()).lastWorkspace;
    if (!configured) throw new Error("还没有当前课程工作区。");
    const root = droppedPath(configured);
    if (!(await fileExists(path.join(root, ".accoding", "workspace.json"))))
      throw new Error("课程尚未配置：" + root);
    const course = await courseSettings(root);
    if (course.language !== "c") throw new Error("此课程使用 C++：" + root);
    const found = await presetForVersion(version);
    const bindings = await new WorkspaceStore(root).list();
    const plan = await chooseUpdateTargets(root, bindings, mode, selected, version);
    return { root, found, ...plan };
  }

  async updateQuestionPresets(
    version: string, mode: UpdateMode, selected: string[] = [], rootArg?: string, setDefault = false
  ) {
    const {root, found, targets, retained} = await this.previewPresetUpdate(version, mode, selected, rootArg);
    if (setDefault) await setCoursePresetVersion(root, version);
    const compiler = await this.configuredToolchain();
    let updated = 0;
    const errors: string[] = [];
    for (const b of targets) {
      try {
        if (await applyPresetVersion(root, b, found, compiler, mode === "empty")) {
          this.tested.delete(sourceFor(b, root));
          updated++;
        }
      } catch (error) {
        errors.push(b.problem.label + " " + b.problem.title + ": " +
          (error instanceof Error ? error.message : String(error)));
      }
    }
    return { updated, retained, errors };
  }

  async undoQuestionPreset(bindingId: string, rootArg?: string): Promise<void> {
    const root = await this.workspaceRoot(rootArg);
    const found = (await new WorkspaceStore(root).list()).find(
      b => b.bindingId === bindingId);
    if (!found) throw new Error("题目不存在。");
    await undoPresetUpdate(root, found);
    this.tested.delete(sourceFor(found, root));
  }

  async importContest(value: string, rootArg?: string, presetPath?: string,
    language?: "c" | "cpp"): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const input = parseImport(value, "contest");
    if (input.kind !== "contest") throw new Error("请提供比赛 ID 或比赛链接。");
    const snapshot = await fetchContestSnapshotForImport(this.session.client, input.id,
      (line) => console.log(line));
    const root = await this.courseRoot(rootArg, language);
    // Check availability before creating contest files.
    const preset = await this.activePreset(presetPath, root);
    const version = presetPath ? undefined : (await courseSettings(root)).presetVersion;
    const folder = await ensureContestDirectory(root, snapshot.id, snapshot.title);
    const workspace = new WorkspaceStore(root);
    const imported = await syncContest(workspace, snapshot, undefined, undefined,
      (problem) => readableProblemDirectory(root, problem, folder));
    for (const binding of imported) {
      if (binding.unavailable) continue;
      await this.ensureScaffold(root, binding, preset, version);
      await this.ensureStatement(root, binding);
    }
    // Sync verdicts before choosing a default, so known AC tasks are not selected.
    await this.refreshContestVerdicts(root, snapshot.id, account, snapshot.problems);
    const state = await this.state.load();
    const alreadyActive = imported.some((b) =>
      this.state.isLastProblem(state, root, b.bindingId, account));
    // Re-importing a contest must not reset the active task to problem A.
    if (!alreadyActive) {
      const next = imported.find((b) =>
        !b.unavailable && !activityAccepted(
          this.state.getActivity(state, root, b.bindingId, account)));
      if (next) await this.state.rememberProblem(root, next.bindingId, account);
    }
    console.log("比赛：" + snapshot.title + "（" + snapshot.id + "）");
    console.log("当前可访问：" + snapshot.problems.length + " 题；本地已处理：" +
      imported.length + " 题。");
  }

  private async refreshContestVerdicts(
    root: string, contestId: string, account: string, problems: Problem[]
  ): Promise<void> {
    // Best-effort status refresh. Import still works if the submission list
    // endpoint is temporarily inaccessible.
    try {
      const result: unknown = await this.session.client.json(
        "/api/contests/" + contestId + "/submissions"
      );
      if (!Array.isArray(result)) return;
      const targets = new Map(problems.map((p) => [p.target.problemId, p.target]));
      const latest = new Map<string, string>();
      for (const row of result) {
        if (!row || typeof row !== "object") continue;
        const s = row as Record<string, unknown>;
        if (String(s.creator_id ?? "") !== account) continue;
        const problemId = String(s.problem_id ?? "");
        const verdict = typeof s.result === "string" ? s.result : "";
        if (!targets.has(problemId) || !verdict) continue;
        if (!isAccepted(latest.get(problemId)) || isAccepted(verdict))
          latest.set(problemId, verdict);
      }
      for (const [id, verdict] of latest) {
        const target = targets.get(id)!;
        await this.state.recordVerdict(root, bindingId(target), account, verdict);
      }
    } catch (error) {
      console.warn("未能同步旧提交状态，稍后可以手动更新：" +
        (error instanceof Error ? error.message : String(error)));
    }
  }

  async importProblem(value: string, rootArg?: string, presetPath?: string,
    language?: "c" | "cpp"): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const input = parseImport(value, "problemset");
    if (input.kind !== "problemset") throw new Error("请提供独立题号或题目链接。");
    let problem: Problem;
    try {
      problem = await new ProblemsetAdapter(this.session.client).fetch(input.id);
    } catch (error) {
      // Only explicit access denial can fall back to the admin reader.
      if (!(error instanceof Error) || !/权限|访问|forbidden/i.test(error.message))
        throw error;
      problem = await new ProblemsetAdapter(this.session.client.adminReader()).fetch(input.id);
    }
    const root = await this.courseRoot(rootArg, language);
    // An unavailable C99 data package should not leave a partially imported problem.
    const preset = await this.activePreset(presetPath, root);
    const version = presetPath ? undefined : (await courseSettings(root)).presetVersion;
    const workspace = new WorkspaceStore(root);
    const binding = await workspace.import(problem,
      await readableProblemDirectory(root, problem));
    await this.ensureScaffold(root, binding, preset, version);
    await this.ensureStatement(root, binding);
    await this.state.rememberProblem(root, binding.bindingId, account);
    console.log("已导入：" + binding.problem.title);
    console.log("目录：" + path.dirname(sourceFor(binding, root)));
  }

  async sync(rootArg?: string, group?: string): Promise<void> {
    await this.account();
    const root = await this.workspaceRoot(rootArg);
    const workspace = new WorkspaceStore(root);
    const all = await workspace.list();
    const contestIds = [...new Set(all.flatMap((b) =>
      b.problem.target.kind === "contest" ? [b.problem.target.contestId] : []))];
    for (const id of contestIds.filter((id) => !group || id === group)) {
      const snapshot = await fetchContestSnapshotForImport(this.session.client, id);
      const folder = await ensureContestDirectory(root, snapshot.id, snapshot.title);
      const bindings = await syncContest(workspace, snapshot, undefined, undefined,
        (problem) => readableProblemDirectory(root, problem, folder));
      for (const binding of bindings) {
        if (!binding.unavailable)
          await this.ensureScaffold(root, binding, await this.activePreset(undefined, root),
            (await courseSettings(root)).presetVersion);
        if (!binding.unavailable) await this.ensureStatement(root, binding);
      }
      console.log("比赛 " + id + " 已同步。");
    }
    for (const binding of all) {
      if (binding.problem.target.kind !== "problemset" || (group && group !== "independent")) continue;
      const problem = await new ProblemsetAdapter(
        binding.problem.target.service === "admin"
          ? this.session.client.adminReader()
          : this.session.client
      ).fetch(binding.problem.target.problemId);
      await workspace.sync(binding, problem);
      await this.ensureStatement(root, binding);
      console.log("题号 " + binding.problem.target.problemId + " 已同步。");
    }
  }

  async resolve(sourceArg: string): Promise<ResolvedProblem> {
    const source = path.resolve(sourceArg);
    const extension = path.extname(source).toLowerCase();
    if (![".c", ".cpp", ".cc", ".cxx"].includes(extension))
      throw new Error("只支持 C/C++ 源文件。");
    if (!(await fileExists(source))) throw new Error("找不到源文件：" + source);
    let directory = path.dirname(source);
    while (true) {
      const index = path.join(directory, ".accoding", "bindings");
      if (await fileExists(index)) {
        const workspace = new WorkspaceStore(directory);
        const bindings = await workspace.list();
        const binding = bindings.find((item) => {
          const known = defaultSourceFiles(item.problem.target);
          const folder = item.problemDirectory ?? path.posix.dirname(known.c);
          const sourceDirectory = localPath(directory, folder);
          if (path.dirname(source) !== sourceDirectory) return false;
          // Only managed entrypoints, or an explicitly bound custom source, can be submitted.
          return path.resolve(directory, item.sourceFile) === source;
        });
        if (!binding) throw new Error("当前文件不属于已初始化的题目。");
        if (binding.unavailable) throw new Error("题目已从比赛移除，暂不能提交。");
        return { root: directory, workspace, binding, source };
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("找不到 Accoding 工作区。请先通过 TUI 初始化比赛或单题。");
  }

  async prepare(resolved: ResolvedProblem): Promise<{
    source: string; code: string; originalHash: string
  }> {
    const original = await fs.readFile(resolved.source, "utf8");
    const originalHash = hash(original);
    const ext = path.extname(resolved.source).toLowerCase();
    let code = stripSourceComments(original, ext !== ".c");
    if (ext !== ".c") {
      if (/^\s*#\s*include\s*"/m.test(code))
        throw new Error("C++ 第一版不支持自动展开自定义头文件，请先合并为单文件。");
    } else {
      const shared = sharedInclude(resolved.root, resolved.source, original);
      if (shared) {
        const preset = await loadPreset(await sharedPresetPath(resolved.root, shared.key));
        return { source: resolved.source, code: assembleC(original, preset, shared.include).code, originalHash };
      }
      const presetFile = path.join(resolved.root, ".accoding", "scaffold",
        resolved.binding.bindingId, "manifest.json");
      const includes = quotedIncludes(original);
      if (!(await fileExists(presetFile))) {
        if (includes.length)
          throw new Error("使用了本地头文件，但未找到可展开的脚手架配置快照。");
      } else {
        const preset = await loadPreset(presetFile);
        if (!includes.some((include) => include.name === preset.manifest.headerFile)) {
          if (includes.length)
            throw new Error("检测到其他本地头文件；C99 单文件模式只支持配置中的头文件。");
        } else {
          const headerPath = path.join(path.dirname(resolved.source),
            preset.manifest.headerFile);
          const implementation = path.join(resolved.root, ".accoding", "scaffold",
            resolved.binding.bindingId, "expanded.h");
          const relative = path.relative(path.dirname(resolved.source), implementation)
            .split(path.sep).join("/");
          const expected = "#ifndef ACCODING_EXAM_WRAPPER_H\n" +
            "#define ACCODING_EXAM_WRAPPER_H\n" +
            '#include "' + relative + '"\n#endif\n';
          const visible = await fs.readFile(headerPath, "utf8");
          if (visible !== expected)
            throw new Error("exam.h 已被修改或不是本程序生成的入口文件，" +
              "为确保本地编译和 OJ 提交一致，已停止源码展开。");
          code = assembleC(original, preset).code;
        }
      }
    }
    return { source: resolved.source, code, originalHash };
  }

  async test(resolved: ResolvedProblem, report?: (result: SampleTestReport) => void): Promise<boolean> {
    const account = (await this.state.load()).lastAccount || "offline";
    this.tested.delete(resolved.source);
    const prepared = await this.prepare(resolved);
    await this.state.rememberProblem(resolved.root, resolved.binding.bindingId,
      account, { sourceFile: resolved.source });
    const cases = resolved.binding.cases.filter(c => c.enabled);
    if (!cases.length) {
      console.log("未找到官方样例，不能自动判定正确。");
      return false;
    }
    const result = await judge(prepared.source, prepared.code, cases,
      await this.configuredToolchain(), undefined, path.dirname(resolved.source));
    try {
      if (result.compilation.exitCode !== 0 || result.compilation.reason) {
        report?.({ kind: "compile", output: result.compilation });
        console.error("编译失败：\n" + result.compilation.stderr);
        return false;
      }
      const originals = new Map(cases.map(c => [c.id, c]));
      const samples = result.cases.map(entry => {
        const original = originals.get(entry.id)!;
        return { ...entry, name: original.name || "样例",
          expected: original.hasExpectedOutput ? original.expected : undefined,
          comparison: original.comparison };
      });
      const passed = samples.filter(entry => entry.status === "PASS").length;
      report?.({ kind: "samples", cases: samples, passed, total: cases.length });
      for (const [i, entry] of samples.entries()) {
        console.log((i + 1) + ". " + entry.name + " : " + entry.status);
        if (entry.status === "FAIL") {
          console.log("  预期：" + (entry.diff?.expected ?? "(无)"));
          console.log("  实际：" + (entry.diff?.actual ?? "(无)"));
        } else if (entry.stderr) {
          console.log("  stderr：" + entry.stderr.slice(0, 500));
        }
      }
      const allPass = passed === cases.length;
      console.log(allPass ? "全部本地样例通过。" : "有用例未通过。");
      if (allPass) this.tested.set(resolved.source, {
        code: prepared.code, stamp: prepared.originalHash
      });
      return allPass;
    } finally {
      await fs.rm(result.directory, { recursive: true, force: true });
    }
  }

  testedCode(source: string): string | undefined {
    return this.tested.get(source)?.code;
  }

  private async chooseLanguage(problem: Problem, source: string, requested?: string): Promise<string> {
    if (requested) {
      if (!problem.languages.includes(requested))
        throw new Error("OJ 不支持指定的提交语言：" + requested);
      return requested;
    }
    const choices = submissionLanguageChoices(problem, source);
    if (choices.length === 1) return choices[0];
    if (!choices.length)
      throw new Error("OJ 不支持此源文件的语言，或语言选项无法识别。");
    if (!interactive())
      throw new Error("请通过 --lang 指定 OJ 提交语言：" + choices.join(", "));
    const chosen = await select("选择 OJ 语言", choices.map((value) =>
      ({ value, label: value })));
    if (!chosen) throw new Error("已取消提交。");
    return chosen;
  }

  async submit(
    resolved: ResolvedProblem, lang?: string, codeSnapshot?: string,
    pickLanguage?: (choices: string[], fallback: boolean) => Promise<string | undefined>
  ): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    // A direct editor submit is a user action, not merely an OJ status refresh.
    await this.state.rememberProblem(resolved.root, resolved.binding.bindingId,
      account, { sourceFile: resolved.source });
    let prepared: { source: string; code: string };
    if (codeSnapshot === undefined) {
      prepared = await this.prepare(resolved);
    } else {
      const tested = this.tested.get(resolved.source);
      if (!tested || tested.code !== codeSnapshot)
        throw new Error("找不到对应的通过测试的源码快照，请重新测试。");
      const current = hash(await fs.readFile(resolved.source, "utf8"));
      if (current !== tested.stamp)
        throw new Error("测试后源码发生修改，请重新测试。");
      prepared = { source: resolved.source, code: codeSnapshot };
    }
    const checked = codeSnapshot === undefined ? await compile(prepared.source, prepared.code,
      await this.configuredToolchain(), undefined, false, path.dirname(resolved.source)) : undefined;
    if (checked) try {
      if (checked.result.exitCode !== 0 || checked.result.reason)
        throw new Error("提交前编译失败，未上传：\n" + checked.result.stderr);
    } finally {
      await fs.rm(checked.directory, { recursive: true, force: true });
    }
    const problem = resolved.binding.problem;
    console.log("即将提交：" + problem.label + " " + problem.title +
      "（" + path.basename(resolved.source) + "）");
    let attemptId: string | undefined;
    const store = new SubmissionStore(path.join(resolved.root, ".accoding", "submissions"));
    try {
      const sent = await sendSubmission(this.session.client, problem.target,
        prepared.code, {
          language: (current, fallback) => {
            if (!pickLanguage || lang) return this.chooseLanguage(current, resolved.source, lang);
            const choices = submissionLanguageChoices(current, resolved.source);
            if (choices.length === 1) return Promise.resolve(choices[0]);
            if (choices.length === 0) throw new Error("OJ 不支持此源文件的语言。");
            return pickLanguage(choices, fallback);
          },
          sending: async (target, language) => {
            const attempt = await store.begin(account, {
              target,
              language,
              sourceHash: hash(prepared.code)
            });
            attemptId = attempt.attemptId;
          }
        });
      if (!sent) {
        console.log("已取消提交。");
        return;
      }
      await store.observe(account, sent, attemptId);
      const submissionBinding = bindingId(sent.target);
      if (submissionBinding !== resolved.binding.bindingId)
        console.log("注意：本次转为题库提交，不计入原比赛成绩。");
      await this.state.recordVerdict(resolved.root, submissionBinding, account, sent.result);
      console.log("提交 ID：" + sent.id + "，OJ 状态：" + sent.result);
      if (isPending(sent)) await this.status(resolved.root, true, sent.target);
    } catch (error) {
      if (attemptId) await store.uncertain(account, attemptId);
      throw error;
    }
  }

  async status(rootArg?: string, watch = false, target?: Target): Promise<void> {
    const account = await this.account();
    if (!account) throw new Error("未登录");
    const root = await this.workspaceRoot(rootArg);
    const store = new SubmissionStore(path.join(root, ".accoding", "submissions"));
    const attempts = await store.list(account, target);
    const uncertain = attempts.filter((entry) =>
      entry.state === "UnknownOutcome" || entry.state === "Sending");
    // Only the problemset adapter can verify the submitted source itself.
    // Never infer an identity from timing alone and never retry an unknown POST.
    for (const attempt of uncertain) {
      if (attempt.target.kind !== "problemset" || !attempt.sourceHash) continue;
      try {
        const adapter = new ProblemsetAdapter(
          attempt.target.service === "admin"
            ? this.session.client.adminReader() : this.session.client);
        const recovered = await adapter.recoverAttempt(attempt.target, account, attempt);
        if (!recovered) continue;
        await store.observe(account, recovered, attempt.attemptId);
        await this.state.recordVerdict(root, bindingId(recovered.target),
          account, recovered.result);
        console.log("已核实并恢复提交 ID：" + recovered.id);
      } catch (error) {
        console.warn("无法核实历史提交，已保留未决状态：" +
          (error instanceof Error ? error.message : String(error)));
      }
    }
    const refreshed = await store.list(account, target);
    const pending = refreshed.filter((entry) =>
      entry.state === "Pending" && entry.submission && isPending(entry.submission));
    const unresolved = refreshed.filter((entry) =>
      entry.state === "UnknownOutcome" || entry.state === "Sending");
    if (unresolved.length)
      console.log(unresolved.length +
        " 条提交结果仍不确定；不会自动重发，请到 Accoding 核对。");
    if (!pending.length) {
      console.log("没有待查询的远程评测。");
      return;
    }
    const get = async (previous: NonNullable<typeof pending[number]["submission"]>) => {
      const target = previous.target;
      return target.kind === "contest"
        ? new ContestAdapter(this.session.client).get(target, previous.id)
        : new ProblemsetAdapter(target.service === "admin"
          ? this.session.client.adminReader() : this.session.client).get(target, previous.id);
    };
    const update = async (submission: NonNullable<typeof pending[number]["submission"]>) => {
      const attempt = pending.find((entry) =>
        entry.submission?.id === submission.id &&
        bindingId(entry.submission.target) === bindingId(submission.target));
      await store.observe(account, submission, attempt?.attemptId);
      await this.state.recordVerdict(root, bindingId(submission.target), account,
        submission.result);
      console.log("题 " + submission.target.problemId + " / " +
        submission.id + "：" + submission.result);
    };
    if (!watch) {
      for (const attempt of pending)
        await update(await get(attempt.submission!));
      return;
    }
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.on("SIGINT", interrupt);
    try {
      const result = await monitorSubmissions({
        submissions: pending.map((entry) => entry.submission!),
        signal: controller.signal,
        get, update, intervalMs: 2000, budgetMs: 180000
      });
      if (result === "waiting") console.log("评测尚未完成，稍后运行 accoding status 继续查询。");
      if (result === "stopped") console.log("已停止等待，远程提交不会撤回。");
    } finally {
      process.off("SIGINT", interrupt);
    }
  }

  async list(rootArg?: string): Promise<ResolvedProblem[]> {
    const root = await this.workspaceRoot(rootArg);
    const workspace = new WorkspaceStore(root);
    const bindings = (await workspace.list()).filter((b) => !b.unavailable);
    const state = await this.state.load();
    const account = this.session.user?.id ?? state.lastAccount ?? "offline";
    const entries = await Promise.all(bindings.map(async (binding) => {
      const source = sourceFor(binding, root);
      const activity = this.state.getActivity(state, root, binding.bindingId, account);
      let modified = 0;
      const known = defaultSourceFiles(binding.problem.target);
      const base = binding.problemDirectory ?? path.posix.dirname(known.c);
      for (const file of [source,
        localPath(root, path.posix.join(base, languages.c.file)),
        localPath(root, path.posix.join(base, languages.cpp.file))]) {
        try { modified = Math.max(modified, (await fs.stat(file)).mtimeMs); }
        catch { /* Optional source may not exist. */ }
      }
      // The remembered path is advisory; it must still point to an existing
      // managed source, not a deleted/moved file or a stale external path.
      let selected = source;
      if (activity.sourceFile) {
        const proposed = path.resolve(activity.sourceFile);
        const allowed = path.dirname(proposed) === path.dirname(source) &&
          (proposed === source || [languages.c.file, languages.cpp.file].includes(path.basename(proposed)));
        if (allowed && await fileExists(proposed)) selected = proposed;
      }
      return {
        root, workspace, binding,
        source: selected,
        modified: Math.max(modified, Date.parse(activity.lastActiveAt || "") || 0),
        verdict: activity.verdict,
        accepted: activityAccepted(activity),
        last: this.state.isLastProblem(state, root, binding.bindingId, account)
      };
    }));
    entries.sort((a, b) =>
      Number(a.accepted) - Number(b.accepted) ||
      b.modified - a.modified ||
      Number(b.last) - Number(a.last) ||
      a.binding.problem.label.localeCompare(b.binding.problem.label));
    return entries.map(({ root, workspace, binding, source }) =>
      ({ root, workspace, binding, source }));
  }

  async selectSource(problem: ResolvedProblem): Promise<ResolvedProblem> {
    const files = defaultSourceFiles(problem.binding.problem.target);
    const base = problem.binding.problemDirectory ?? path.posix.dirname(files.c);
    const result = await select("选择源码语言", [
      { label: "C (.c)", value: path.posix.join(base, languages.c.file) },
      { label: "C++ (.cpp)", value: path.posix.join(base, languages.cpp.file) }
    ]);
    if (!result) return problem;
    const source = localPath(problem.root, result);
    const binding = await problem.workspace.update(
      problem.binding.bindingId, problem.binding.revision,
      (b) => { b.sourceFile = result; delete b.selectedSubmissionLanguage; }
    );
    const account = this.session.user?.id ??
      (await this.state.load()).lastAccount ?? "offline";
    await this.state.rememberProblem(problem.root, binding.bindingId, account,
      { sourceFile: source });
    return { ...problem, binding, source };
  }

  dispose() { this.session.dispose(); }
}
