import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire as createNodeRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { StandaloneWorkflow, ResolvedProblem } from "./workflow";

const exec = promisify(execFile);
const runtimeRequire = createNodeRequire(import.meta.url);
const PACKAGE = "@annouimo/c-observer";
const SESSION_SCHEMA = 1;

export function resolvePackageFile(name: string, file: string): string | undefined {
  try { return runtimeRequire.resolve(name + "/" + file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return;
    throw error;
  }
}

export function observerBinaryFromManifest(root: string, value: unknown, platform = process.platform as string, arch = process.arch as string): string {
  const data = value as { schemaVersion?: number; sessionSchemaVersions?: number[]; platforms?: Record<string, { executable?: string }> } | null;
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.sessionSchemaVersions) || !data.sessionSchemaVersions.includes(SESSION_SCHEMA))
    throw new Error("C Observer 软件包协议不兼容。");
  const executable = data.platforms?.[platform + "-" + arch]?.executable;
  if (typeof executable !== "string") throw new Error("当前平台尚未提供 C Observer。");
  const binary = path.resolve(root, executable);
  const relative = path.relative(root, binary);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("C Observer 软件包路径无效。");
  return binary;
}

export async function resolveObserver(): Promise<string> {
  const override = process.env.ACCODING_OBSERVER_PATH;
  let binary: string;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error("ACCODING_OBSERVER_PATH 必须是绝对路径。");
    binary = override;
  } else {
    const manifest = resolvePackageFile(PACKAGE, "manifest.json");
    if (!manifest) throw new Error("未安装 C Observer。请更新 Companion；开发联调可指定 ACCODING_OBSERVER_PATH。");
    binary = observerBinaryFromManifest(path.dirname(manifest), JSON.parse(await fs.readFile(manifest,"utf8")));
  }
  const info = await fs.stat(binary).catch(() => undefined);
  if (!info?.isFile()) throw new Error("找不到 C Observer 可执行文件。");
  const { stdout } = await exec(binary, ["--capabilities"], { timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const capability = JSON.parse(stdout) as { sessionSchemaVersions?: number[]; backends?: string[] };
  if (!Array.isArray(capability.sessionSchemaVersions) || !capability.sessionSchemaVersions.includes(SESSION_SCHEMA) ||
      !Array.isArray(capability.backends) || !capability.backends.length)
    throw new Error("C Observer 当前版本不支持本机观察协议或后端。");
  return binary;
}

export interface ObserveSelection {
  caseId?: string;
  revision?: number;
  input?: string;
  expected?: string;
}

export interface PreparedObservation {
  binary: string;
  sessionPath: string;
  dispose: () => Promise<void>;
}

// Reassemble current source, never imply it is the immutable previously tested
// version. Freeze the original text from the same prepare call for #line mapping.
export async function prepareObservation(app: StandaloneWorkflow, problem: ResolvedProblem, selection: ObserveSelection): Promise<PreparedObservation> {
  if (path.extname(problem.source).toLowerCase() !== ".c") throw new Error("C Observer 目前只支持 C 源文件。");
  const binary = await resolveObserver();
  const fresh = await app.resolve(problem.source);
  if (fresh.binding.bindingId !== problem.binding.bindingId) throw new Error("题目绑定已变化，请重新选择。");
  const sample = selection.caseId === undefined ? undefined : fresh.binding.cases.find(c => c.id === selection.caseId && c.enabled);
  if (selection.caseId !== undefined && (!sample || (selection.revision !== undefined && sample.revision !== selection.revision)))
    throw new Error("样例已修改或禁用，请重新测试后再观察。");
  const input = sample?.input ?? selection.input ?? "";
  const expected = sample ? (sample.hasExpectedOutput ? sample.expected : undefined) : selection.expected;
  if (Buffer.byteLength(input) > 4*1024*1024 || (expected !== undefined && Buffer.byteLength(expected)>4*1024*1024))
    throw new Error("样例超过观察器 4 MiB 限制。");
  const prepared = await app.prepare(fresh);
  const tc = await app.configuredToolchain();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-observer-"));
  const dispose = () => fs.rm(dir, { recursive: true, force: true });
  try {
    const sourceName = path.basename(fresh.source);
    const userPath = path.join("user", sourceName);
    await fs.mkdir(path.join(dir,"user"));
    const unmapped = prepared.diagnosticCode === "#line 1 " + JSON.stringify(sourceName) + "\n" + prepared.original;
    // A plain C file already has the correct physical line numbers. Avoid a
    // redundant SourceMap, which disables the current LLDB identity analysis.
    if (!unmapped) await fs.writeFile(path.join(dir,"observe.c"),prepared.diagnosticCode,{mode:0o600});
    await fs.writeFile(path.join(dir,userPath),prepared.original,{mode:0o600});
    await fs.writeFile(path.join(dir,"sample.in"),input,{mode:0o600});
    if (expected !== undefined) await fs.writeFile(path.join(dir,"sample.out"),expected,{mode:0o600});
    const workDir = path.dirname(fresh.source);
    const map = { [sourceName]: userPath, [path.join(workDir,sourceName)]: userPath, [path.join(dir,sourceName)]: userPath };
    const compiler = /[\\/]/.test(tc.c) && !path.isAbsolute(tc.c) ? path.resolve(tc.c) : tc.c;
    const session = {
      schemaVersion: SESSION_SCHEMA, sourcePath: unmapped ? userPath : "observe.c", workDir,
      ...(unmapped ? {} : { visibleSourcePaths: [userPath], sourceMap: map }), compiler,
      compilerArgs: tc.cLinkArgs ?? [], stdinFile: "sample.in",
      ...(expected === undefined ? {} : { expectedStdoutFile: "sample.out" })
    };
    const sessionPath = path.join(dir,"session.json");
    await fs.writeFile(sessionPath,JSON.stringify(session,null,2)+"\n",{mode:0o600});
    return { binary, sessionPath, dispose };
  } catch (error) { await dispose(); throw error; }
}

export async function runObservation(task: PreparedObservation): Promise<void> {
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("运行观察需要交互终端。");
    // Ink has exited, but Node may still have a flowing TTY read handle.
    // Stop parent reads before handing the terminal file descriptors to Go.
    process.stdin.pause();
    if (process.stdin.isRaw) process.stdin.setRawMode(false);
    await new Promise<void>((resolve,reject) => {
      const child = spawn(task.binary, ["--session",task.sessionPath], { stdio: "inherit", shell: false });
      // Both programs share the terminal process group. Do not exit the parent
      // before the observer gets SIGINT and has finished cleaning up.
      const interrupt = () => {};
      process.on("SIGINT", interrupt);
      const clean = () => process.off("SIGINT",interrupt);
      child.once("error", error => { clean(); reject(error); });
      child.once("close", (code,signal) => {
        clean();
        if (code === 0) resolve();
        else reject(new Error("C Observer 退出：" + (signal ?? code ?? "unknown")));
      });
    });
  } finally { await task.dispose(); }
}
