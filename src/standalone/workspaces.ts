import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Problem } from "../model";
import { ask, confirm, interactive, select } from "./terminal";

export function droppedPath(raw: string, cwd = process.cwd(), home = os.homedir()): string {
  let text = raw.trim();
  // macOS Finder/Terminal can paste quoted paths or shell-escaped spaces.
  if ((text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith('"') && text.endsWith('"')))
    text = text.slice(1, -1);
  else if (process.platform !== "win32")
    text = text.replace(/\\([ \\()'"\[\]{}!#&;$])/g, "$1");
  if (text === "~") text = home;
  else if (text.startsWith("~/") || text.startsWith("~\\"))
    text = path.join(home, text.slice(2));
  if (!text || /[\r\n\0]/.test(text)) throw new Error("请输入单个有效的目录路径。");
  return path.resolve(cwd, text);
}

export function readableName(raw: string, fallback = "未命名"): string {
  let text = raw.normalize("NFC")
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "").trim().slice(0, 65).trim();
  // Names must be valid for Windows even if generated on macOS.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text))
    text = "_" + text;
  return text || fallback;
}

export function preferredRoot(title: string): string {
  return path.join(os.homedir(), "Accoding", readableName(title));
}

export async function selectWorkspaceDirectory(title: string, explicit?: string): Promise<string> {
  if (explicit) return droppedPath(explicit);
  const suggested = preferredRoot(title);
  if (!interactive()) return suggested;
  console.log("\n保存目录：可以把 Finder 或文件资源管理器中的文件夹拖进终端，再按回车。");
  console.log("每场比赛只需选择一次，已存在的源文件不会被覆盖。");
  const entered = await ask("保存到", suggested);
  const selected = droppedPath(entered);
  try {
    const stat = await fs.stat(selected);
    if (!stat.isDirectory()) throw new Error("选择的路径不是文件夹：" + selected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (selected !== suggested &&
        !(await confirm("文件夹不存在，是否创建：" + selected + "？", true)))
      throw new Error("已取消创建工作区。");
  }
  return selected;
}

async function exists(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function isFriendlyWorkspace(root: string): Promise<boolean> {
  try {
    const config = JSON.parse(await fs.readFile(
      path.join(root, ".accoding", "workspace.json"), "utf8")) as CourseSettings;
    return config.kind === "course" && config.schemaVersion === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Kept as a compatibility helper. New courses are initialized by courseSettings. */
export async function initializeFriendlyLayout(root: string): Promise<boolean> {
  return isFriendlyWorkspace(root);
}

export async function readableProblemDirectory(
  root: string, problem: Problem, parentDirectory?: string
): Promise<string> {
  const label = problem.target.kind === "contest"
    ? readableName(problem.label, "题")
    : "题目";
  const candidate = readableName(label + "-" + problem.title);
  const prefix = parentDirectory || (problem.target.kind === "problemset"
    ? await ensureIndependentDirectory(root) : "");
  if (!prefix) throw new Error("必须先为比赛建立专属文件夹。");
  await fs.mkdir(path.join(root, prefix), { recursive: true });
  const relative = (name: string) => path.join(prefix, name);
  if (!(await exists(path.join(root, relative(candidate))))) return relative(candidate);
  // Avoid accidentally taking ownership of an unrelated user's directory.
  const suffix = problem.target.problemId;
  const withId = readableName(candidate.slice(0, 54)) + "-" + suffix;
  if (!(await exists(path.join(root, relative(withId))))) return relative(withId);
  for (let i = 2; i < 1000; i++) {
    const name = withId + "-" + i;
    if (!(await exists(path.join(root, relative(name))))) return relative(name);
  }
  throw new Error("无法为题目分配不冲突的文件夹名称。");
}


export interface CourseSettings {
  schemaVersion: 1;
  kind: "course";
  language: "c" | "cpp";
  presetVersion?: string;
}

/** One course workspace, one language, any number of contest subdirectories. */
export async function courseSettings(root: string, requested?: "c" | "cpp"): Promise<CourseSettings> {
  const file = path.join(root, ".accoding", "workspace.json");
  try {
    const config: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!config || typeof config !== "object" ||
        (config as CourseSettings).schemaVersion !== 1 ||
        (config as CourseSettings).kind !== "course" ||
        !["c", "cpp"].includes((config as CourseSettings).language)) {
      throw new Error("课程工作区配置格式未知；原文件已保留。");
    }
    const saved = config as CourseSettings;
    if (requested && saved.language !== requested)
      throw new Error("本工作区固定使用 " + saved.language +
        "；请建立或切换另一个工作区，而不是更改已有源码语言。");
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Never silently take ownership of a legacy workspace or unrelated data.
  if (await exists(path.join(root, ".better-accoding")))
    throw new Error("检测到旧版工作区，请先使用旧版或执行经过备份的数据迁移。");
  let language = requested;
  if (!language && interactive()) {
    const picked = await select("首次配置课程工作区：选择固定编程语言", [
      { label: "C99", value: "c" }, { label: "C++17", value: "cpp" }
    ]);
    if (!picked) throw new Error("取消初始化工作区。");
    language = picked as "c" | "cpp";
  }
  if (!language)
    throw new Error("首次以非交互方式初始化工作区，请指定 --workspace-lang c 或 cpp。");
  const config: CourseSettings = { schemaVersion: 1, kind: "course", language };
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n",
      { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return courseSettings(root, requested);
  }
  return config;
}

/** Ask for a course root only once, not on every contest import. */
export async function selectCourseDirectory(saved?: string, explicit?: string): Promise<string> {
  if (explicit) return droppedPath(explicit);
  if (saved) return droppedPath(saved);
  const suggested = path.join(os.homedir(), "Accoding");
  if (!interactive())
    throw new Error("首次初始化请指定 --root DIR 和 --workspace-lang c|cpp。");
  console.log("首次使用：选择课程文件夹。以后比赛会自动放进此文件夹。");
  console.log("可从 Finder / 文件资源管理器拖入路径。");
  const raw = await ask("课程文件夹", suggested);
  return droppedPath(raw);
}

/** Never claim an unrelated user-owned directory just because its name matches. */
export async function ensureContestDirectory(
  root: string, contestId: string, title: string
): Promise<string> {
  if (!/^\d+$/.test(contestId)) throw new Error("无效比赛 ID");
  const metadata = path.join(root, ".accoding", "contests", contestId + ".location.json");
  try {
    const info = JSON.parse(await fs.readFile(metadata, "utf8")) as {
      contestId: string; directory: string;
    };
    if (info.contestId !== contestId ||
        !info.directory || path.basename(info.directory) !== info.directory)
      throw new Error("已保存的比赛目录信息异常。");
    if (!(await exists(path.join(root, info.directory))))
      throw new Error("比赛文件夹已被移走，请先恢复后再同步。");
    return info.directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const base = readableName(title, "比赛-" + contestId);
  for (const candidate of [base, base + "-" + contestId]) {
    try {
      await fs.mkdir(path.join(root, candidate));
      await fs.mkdir(path.dirname(metadata), { recursive: true });
      await fs.writeFile(metadata, JSON.stringify({
        schemaVersion: 1, contestId, directory: candidate, title
      }, null, 2) + "\n", { flag: "wx", encoding: "utf8" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // If another process registered the exact contest, use its folder.
      if (await exists(metadata)) return ensureContestDirectory(root, contestId, title);
    }
  }
  throw new Error("已有同名目录，请重命名其中一个目录后重试；不会覆盖用户文件夹。");
}

/** Keep imported standalone exercises separate from a user's own similarly named folder. */
export async function ensureIndependentDirectory(root: string): Promise<string> {
  const marker = path.join(root, ".accoding", "independent-folder.json");
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8")) as {
      kind?: string; directory?: string;
    };
    if (parsed.kind !== "independent" || !parsed.directory ||
        path.basename(parsed.directory) !== parsed.directory)
      throw new Error("独立题目录索引损坏，未修改任何文件。");
    return parsed.directory;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const candidate of ["独立题目", "独立题目-Accoding"]) {
    try {
      await fs.mkdir(path.join(root, candidate));
      await fs.mkdir(path.dirname(marker), { recursive: true });
      await fs.writeFile(marker, JSON.stringify({
        schemaVersion: 1, kind: "independent", directory: candidate
      }) + "\n", { flag: "wx" });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await exists(marker)) return ensureIndependentDirectory(root);
    }
  }
  throw new Error("独立题目目录已被占用，请先手动选择其他课程工作区。");
}
