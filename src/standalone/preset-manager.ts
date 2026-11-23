import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./state";
import { loadPreset, renderHeader, assembleC } from "./scaffold";
import { atomicWrite, safePath } from "../workspace/fs";
import { withWorkspaceLock } from "../workspace/lock";
import { compile, type Toolchain } from "../judge/judge";
import { hash, type Binding } from "../model";

const DATA_PACKAGE = "@annouimo/c-exam-kit-preset";
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export interface InstalledPreset {
  version: string;
  manifestPath: string;
}

/** Discover data-only packages downloaded by install.sh / install.ps1. No network. */
export async function installedPresets(): Promise<InstalledPreset[]> {
  const folder = path.join(dataDirectory(), "presets");
  let names: string[];
  try { names = await fs.readdir(folder); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: InstalledPreset[] = [];
  for (const version of names) {
    if (!VERSION.test(version)) continue;
    const packageRoot = path.join(folder, version, "node_modules", DATA_PACKAGE);
    const manifestPath = path.join(packageRoot, "preset", "manifest.json");
    try {
      const info = JSON.parse(await fs.readFile(
        path.join(packageRoot, "package.json"), "utf8")) as { name?: string; version?: string };
      if (info.name !== DATA_PACKAGE || info.version !== version) continue;
      await loadPreset(manifestPath);
      found.push({ version, manifestPath });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("已下载的脚手架数据损坏：" + version);
    }
  }
  found.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return found;
}

export async function presetForVersion(version: string): Promise<InstalledPreset> {
  if (!VERSION.test(version)) throw new Error("无效的脚手架版本号。");
  const found = (await installedPresets()).find((item) => item.version === version);
  if (!found) throw new Error("此脚手架版本尚未安装；请先运行安装器下载。");
  return found;
}

export async function setCoursePresetVersion(root: string, version: string): Promise<void> {
  await presetForVersion(version);
  const file = await safePath(root, ".accoding/workspace.json");
  const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  if (config.kind !== "course") throw new Error("不是有效的课程工作区。");
  config.presetVersion = version;
  await atomicWrite(file, JSON.stringify(config, null, 2) + "\n");
}

export type UpdateMode = "unaccepted" | "empty" | "all" | "selected";

export async function chooseUpdateTargets(
  root: string,
  bindings: Binding[],
  mode: UpdateMode,
  activity: (b: Binding) => { accepted?: boolean; verdict?: string },
  selected: string[] = []
): Promise<{ targets: Binding[]; excludedUnknown: number }> {
  const eligible = bindings.filter(b => !b.unavailable &&
    b.sourceFile.toLowerCase().endsWith(".c"));
  if (mode === "all") return { targets: eligible, excludedUnknown: 0 };
  if (mode === "selected") return {
    targets: eligible.filter(b => selected.includes(b.bindingId)), excludedUnknown: 0
  };
  if (mode === "unaccepted") {
    const known = eligible.filter(b => activity(b).accepted ||
      typeof activity(b).verdict === "string");
    return {
      targets: known.filter(b => !activity(b).accepted &&
        activity(b).verdict?.trim().toUpperCase() !== "AC"),
      excludedUnknown: eligible.length - known.length
    };
  }
  const blank: Binding[] = [];
  let unknown = 0;
  for (const b of eligible) {
    const mark = path.join(root, ".accoding", "initial-hashes", b.bindingId + ".json");
    let initial: string | undefined;
    try { initial = (JSON.parse(await fs.readFile(mark, "utf8")) as
      { sourceHash?: string }).sourceHash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!initial) { unknown++; continue; }
    const code = await fs.readFile(await safePath(root, b.sourceFile), "utf8");
    if (hash(code) === initial) blank.push(b);
  }
  return { targets: blank, excludedUnknown: unknown };
}

function relativeHeader(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

async function stagePreset(folder: string, manifestPath: string, version: string) {
  const preset = await loadPreset(manifestPath);
  await fs.mkdir(folder, { recursive: true });
  for (const part of preset.manifest.components) {
    const file = path.resolve(folder, part.source);
    if (path.relative(folder, file).startsWith(".."))
      throw new Error("组件路径越界。");
    await fs.mkdir(path.dirname(file), {recursive:true});
    await fs.writeFile(file, preset.code.get(part.id)!, {flag:"wx"});
  }
  await fs.writeFile(path.join(folder, "manifest.json"),
    JSON.stringify(preset.manifest, null, 2)+"\n", {flag:"wx"});
  await fs.writeFile(path.join(folder, "expanded.h"), renderHeader(preset), {flag:"wx"});
  await fs.writeFile(path.join(folder, "version.json"),
    JSON.stringify({ version, preset: preset.manifest.id }, null, 2)+"\n", {flag:"wx"});
  return preset;
}

export async function applyPresetVersion(
  root: string, binding: Binding, installed: InstalledPreset, toolchain: Toolchain
): Promise<void> {
  const key = binding.bindingId;
  if (!/^(?:admin-)?problem-\d+$|^contest-\d+-\d+$/.test(key))
    throw new Error("题目 ID 非法");
  const source = await safePath(root, binding.sourceFile);
  if (path.extname(source).toLowerCase() !== ".c")
    throw new Error("仅 C99 工作区支持 C Exam Kit。");
  const base = await safePath(root, ".accoding/scaffold");
  const active = await safePath(root, ".accoding/scaffold/" + key);
  const expanded = path.join(active, "expanded.h");
  const manifest = path.join(active, "manifest.json");
  const preset = await loadPreset(installed.manifestPath);
  const visibleHeader = path.join(path.dirname(source), preset.manifest.headerFile);
  // The visible header must be the wrapper we generated, not user-edited content.
  const wrapper = await fs.readFile(visibleHeader, "utf8");
  const expected = relativeHeader(path.dirname(source), expanded);
  if (!wrapper.includes('#include "' + expected + '"'))
    throw new Error("exam.h 已被用户修改，不自动覆盖或更新此题。");
  const code = await fs.readFile(source, "utf8");
  const expandedCode = code.includes('#include "' + preset.manifest.headerFile + '"')
    ? assembleC(code, preset).code : code;
  // Compile-check the replacement before touching active library files.
  const temp = await safePath(root, ".accoding/cache/preset-" + randomUUID() + ".c");
  await fs.mkdir(path.dirname(temp), { recursive: true });
  await fs.writeFile(temp, expandedCode, { flag: "wx" });
  try {
    const checked = await compile(temp, path.join(root, ".accoding", "cache", "compiles"),
      toolchain, undefined, false, path.dirname(source));
    try {
      if (checked.result.exitCode !== 0 || checked.result.reason)
        throw new Error("使用新版组件编译失败：" + checked.result.stderr.slice(0, 800));
    } finally {
      await fs.rm(checked.directory, { recursive: true, force: true });
    }
  } finally { await fs.rm(temp, {force:true}); }
  await withWorkspaceLock(path.join(base, "update.lock"), async () => {
    const stage = path.join(base, ".stage-" + randomUUID());
    const history = await safePath(root, ".accoding/scaffold-history/" + key);
    await fs.mkdir(history, {recursive:true});
    const backup = path.join(history, new Date().toISOString().replace(/[:.]/g,"-") +
      "-" + randomUUID());
    try {
      await stagePreset(stage, installed.manifestPath, installed.version);
      let moved = false;
      try {
        await fs.rename(active, backup);
        moved = true;
        await fs.rename(stage, active);
      } catch (error) {
        if (moved) await fs.rename(backup, active);
        throw error;
      }
    } finally { await fs.rm(stage, { recursive:true, force:true }); }
  });
}

export async function undoPresetUpdate(root: string, binding: Binding): Promise<void> {
  const key = binding.bindingId;
  const active = await safePath(root, ".accoding/scaffold/" + key);
  const history = await safePath(root, ".accoding/scaffold-history/" + key);
  const list = (await fs.readdir(history)).sort();
  if (!list.length) throw new Error("没有可撤销的脚手架版本。");
  await withWorkspaceLock(path.join(root, ".accoding/scaffold", "update.lock"), async () => {
    const latest = path.join(history, list[list.length-1]);
    const undo = path.join(history, "redo-" + randomUUID());
    await fs.rename(active, undo);
    try { await fs.rename(latest, active); }
    catch (error) { await fs.rename(undo, active); throw error; }
  });
}
