import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { hash, type TestCase, type Comparison } from "../model";
import { runProcess, type ProcessResult } from "./process";
export function normalizeOutput(text: string, mode: Comparison) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (mode === "trim-line-end")
    return normalized.split("\n").map(line => line.replace(/[ \t]+$/, ""))
      .join("\n").replace(/\n+$/, "");
  if (mode === "tokens") return normalized.match(/\S+/g)?.join("\n") ?? "";
  return normalized;
}
export function compare(actual: string, expected: string, mode: Comparison) {
  const a = normalizeOutput(actual, mode),
    b = normalizeOutput(expected, mode);
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return {
    equal: a === b,
    line: a.slice(0, index).split("\n").length,
    actual: visible(a.slice(index, index + 80)),
    expected: visible(b.slice(index, index + 80)),
  };
}
function visible(text: string) {
  return (
    text.replace(/ /g, "·").replace(/\t/g, "→").replace(/\n/g, "↵\n") ||
    "〈末尾〉"
  );
}
export class CompilerUnavailableError extends Error {
  constructor(language: string, compiler: string, cause: unknown) {
    super(`未找到 ${language} 编译器（${compiler}）。请安装编译器，或在设置中指定已有编译器。`, { cause });
    this.name = "CompilerUnavailableError";
  }
}
export interface Toolchain {
  c: string;
  cpp: string;
  cArgs: string[];
  cppArgs: string[];
  cLinkArgs?: string[];
  cppLinkArgs?: string[];
  timeoutMs: number;
  outputLimit: number;
}
export interface CaseResult extends ProcessResult {
  contentHash: string;
  id: string;
  revision: number;
  status:
    | "PASS"
    | "FAIL"
    | "RE"
    | "TIMEOUT"
    | "CANCELLED"
    | "OUTPUT_LIMIT"
    | "UNCHECKED";
  diff?: ReturnType<typeof compare>;
}
export interface JudgeResult {
  runId: string;
  sourceHash: string;
  toolchainConfigHash: string;
  compilation: ProcessResult;
  cases: CaseResult[];
  directory: string;
}
export async function compile(
  source: string,
  code: string,
  toolchain: Toolchain,
  signal?: AbortSignal,
  debug = false,
  workingDirectory?: string,
) {
  const ext = path.extname(source).toLowerCase();
  if (![".c", ".cpp", ".cc", ".cxx"].includes(ext))
    throw new Error("本地评测仅支持 C/C++ 文件。");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-"));
  const snapshot = path.join(directory, `submit${ext}`);
  const program = path.join(directory, process.platform === "win32" ? "program.exe" : "program");
  const isC = ext === ".c";
  const flags = isC ? toolchain.cArgs : toolchain.cppArgs;
  const cwd = workingDirectory ?? path.dirname(source);
  const artifactArgument = (file: string) => {
    const relative = path.relative(cwd, file);
    return path.isAbsolute(relative) ? relative : `.${path.sep}${relative}`;
  };
  const args = [
    ...flags,
    ...(debug ? ["-g", "-O0"] : []),
    "-iquote",
    ".",
    artifactArgument(snapshot),
    "-o",
    artifactArgument(program),
    ...(isC ? toolchain.cLinkArgs ?? [] : toolchain.cppLinkArgs ?? []),
  ];
  const configuredCompiler = isC ? toolchain.c : toolchain.cpp;
  const compiler =
    configuredCompiler.includes("/") || configuredCompiler.includes("\\")
      ? path.resolve(cwd, configuredCompiler)
      : configuredCompiler;
  // An explicitly chosen Windows compiler may need its sibling runtime DLLs.
  // Only child processes receive this PATH; the user's system is unchanged.
  let env: NodeJS.ProcessEnv | undefined;
  if (process.platform === "win32" && path.isAbsolute(compiler)) {
    env = { ...process.env };
    const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "Path";
    env[key] = [path.dirname(compiler), env[key]].filter(Boolean).join(path.delimiter);
  }
  // MinGW linkers may decode absolute Unicode paths through the system code page.
  // Relative artifact paths avoid repeating Unicode ancestors while retaining
  // the source directory as cwd for user-supplied include/library arguments.
  try {
    await fs.writeFile(snapshot, code);
    const result = await runProcess(compiler, args, {
      cwd,
      env,
      timeoutMs: 30000,
      outputLimit: toolchain.outputLimit,
      signal,
    });
    return { result, program, directory, sourceHash: hash(code), env };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    if (error instanceof Error && (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" &&
        await fs.stat(cwd).then(info => info.isDirectory(), () => false)) {
      throw new CompilerUnavailableError(isC ? "C" : "C++", configuredCompiler, error);
    }
    throw error;
  }
}
export async function judge(
  source: string,
  code: string,
  cases: TestCase[],
  toolchain: Toolchain,
  signal?: AbortSignal,
  workingDirectory?: string,
): Promise<JudgeResult> {
  const snapshot = structuredClone(cases.filter((c) => c.enabled));
  const built = await compile(source, code, toolchain, signal, false, workingDirectory);
  const output: JudgeResult = {
    runId: path.basename(built.directory),
    sourceHash: built.sourceHash,
    toolchainConfigHash: hash(JSON.stringify(toolchain)),
    compilation: built.result,
    cases: [],
    directory: built.directory,
  };
  if (built.result.exitCode !== 0 || built.result.reason) return output;
  try {
    for (const c of snapshot) {
      const result = await runProcess(built.program, [], {
        cwd: workingDirectory ?? path.dirname(source),
        env: built.env,
        input: c.input,
        timeoutMs: toolchain.timeoutMs,
        outputLimit: toolchain.outputLimit,
        signal,
      });
      const diff = c.hasExpectedOutput
        ? compare(result.stdout, c.expected, c.comparison)
        : undefined;
      const status =
        result.reason ??
        (result.exitCode !== 0
          ? "RE"
          : !diff
            ? "UNCHECKED"
            : diff.equal
              ? "PASS"
              : "FAIL");
      output.cases.push({
        ...result,
        id: c.id,
        revision: c.revision,
        contentHash: hash(
          JSON.stringify([
            c.input,
            c.expected,
            c.hasExpectedOutput,
            c.comparison,
          ]),
        ),
        status,
        diff,
      });
      if (status === "CANCELLED") break;
    }
  } catch (error) {
    await fs.rm(built.directory, { recursive: true, force: true });
    throw error;
  }
  return output;
}
