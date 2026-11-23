import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./state";
import { loadPreset, renderHeader, assembleC, quotedIncludes, type LoadedPreset } from "./scaffold";
import { atomicWrite, safePath } from "../workspace/fs";
import { withWorkspaceLock } from "../workspace/lock";
import { compile, type Toolchain } from "../judge/judge";
import { WorkspaceStore } from "../workspace/store";
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
  const installed = await presetForVersion(version);
  await saveSharedPreset(root, await loadPreset(installed.manifestPath), version);
  const file = await safePath(root, ".accoding/workspace.json");
  await withWorkspaceLock(path.join(path.dirname(file), "write.lock"), async () => {
    const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    if (config.kind !== "course" || config.language !== "c")
      throw new Error("此课程不使用 C99 脚手架。");
    config.presetVersion = version;
    await atomicWrite(file, JSON.stringify(config, null, 2) + "\n");
  });
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
    let initial = b.initialSourceHash;
    try { initial ??= (JSON.parse(await fs.readFile(mark, "utf8")) as
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

const SNAPSHOT_KEY = /^(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?|local-[a-f0-9]{64})$/;

export function presetFingerprint(preset: LoadedPreset): string {
  return hash(JSON.stringify([preset.manifest, [...preset.code]]));
}

export async function sharedPresetPath(root: string, key: string): Promise<string> {
  if (!SNAPSHOT_KEY.test(key)) throw new Error("无效的工作区脚手架版本。");
  return safePath(root, ".accoding/presets/" + key);
}

export async function saveSharedPreset(root: string, preset: LoadedPreset, version?: string) {
  const fingerprint = presetFingerprint(preset);
  const key = version ?? "local-" + fingerprint;
  const destination = await sharedPresetPath(root, key);
  const base = path.dirname(destination);
  await withWorkspaceLock(path.join(base, "write.lock"), async () => {
    try {
      const existing = await loadPreset(destination);
      if (presetFingerprint(existing) !== fingerprint)
        throw new Error("已保存的脚手架版本与安装包内容不一致：" + key);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const stage = path.join(base, ".stage-" + randomUUID());
    try {
      for (const component of preset.manifest.components) {
        const target = await safePath(stage, component.source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, preset.code.get(component.id)!, { flag: "wx" });
      }
      await fs.writeFile(path.join(stage, "manifest.json"),
        JSON.stringify(preset.manifest, null, 2) + "\n");
      await fs.writeFile(path.join(stage, "expanded.h"), renderHeader(preset));
      await fs.rename(stage, destination);
    } finally {
      await fs.rm(stage, { recursive: true, force: true });
    }
  });
  return { key, directory: destination };
}

export function presetInclude(source: string, directory: string): string {
  return path.relative(path.dirname(source), path.join(directory, "expanded.h")).split(path.sep).join("/");
}

export function sharedInclude(root: string, source: string, code: string) {
  const base = path.join(root, ".accoding", "presets");
  for (const { name } of quotedIncludes(code)) {
    const file = path.resolve(path.dirname(source), name);
    const [key, header, extra] = path.relative(base, file).split(path.sep);
    if (SNAPSHOT_KEY.test(key) && header === "expanded.h" && !extra)
      return { key, include: name };
  }
}

function replaceInclude(code: string, before: string, after: string): string {
  const includes = quotedIncludes(code).filter((include) => include.name === before);
  if (includes.length !== 1) throw new Error("应且仅应引用一次脚手架头文件。");
  const { start, end } = includes[0];
  return code.slice(0, start) + after + code.slice(end);
}

async function previousPreset(
  root: string, binding: Binding, source: string, code: string
): Promise<{ key: string; include: string } | undefined> {
  const shared = sharedInclude(root, source, code);
  if (shared) return shared;
  const directory = await safePath(root, ".accoding/scaffold/" + binding.bindingId);
  let preset: LoadedPreset;
  try { preset = await loadPreset(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const include = preset.manifest.headerFile;
  const wrapper = await fs.readFile(path.join(path.dirname(source), include), "utf8");
  const expected = "#ifndef ACCODING_EXAM_WRAPPER_H\n#define ACCODING_EXAM_WRAPPER_H\n" +
    '#include "' + presetInclude(source, directory) + '"\n#endif\n';
  if (wrapper.replaceAll("\r\n", "\n") !== expected ||
      await fs.readFile(path.join(directory, "expanded.h"), "utf8") !== renderHeader(preset))
    throw new Error("旧 exam.h 或完整头文件已被修改，请先核对。");
  const saved = await saveSharedPreset(root, preset);
  return { key: saved.key, include };
}

export async function applyPresetVersion(
  root: string, binding: Binding, installed: InstalledPreset, toolchain: Toolchain
): Promise<void> {
  const source = await safePath(root, binding.sourceFile);
  if (path.extname(source).toLowerCase() !== ".c") throw new Error("仅 C99 支持 C Exam Kit。");
  const preset = await loadPreset(installed.manifestPath);
  const target = await saveSharedPreset(root, preset, installed.version);
  const nextInclude = presetInclude(source, target.directory);
  await withWorkspaceLock(path.join(root, ".accoding", "presets", "switch.lock"), async () => {
    const workspace = new WorkspaceStore(root);
    const current = await workspace.read(binding.bindingId);
    const code = await fs.readFile(source, "utf8");
    const previous = await previousPreset(root, current, source, code);
    if (!previous) throw new Error("此题没有可切换的脚手架引用。");
    if (previous.key === target.key && previous.include === nextInclude) return;
    const updated = replaceInclude(code, previous.include, nextInclude);
    if (updated === code) throw new Error("找不到此题的脚手架 include。");
    const expanded = assembleC(updated, preset, nextInclude).code;
    const checked = await compile(source, expanded, toolchain);
    try {
      if (checked.result.exitCode !== 0 || checked.result.reason)
        throw new Error("使用新版组件编译失败：" + checked.result.stderr.slice(0, 800));
    } finally {
      await fs.rm(checked.directory, { recursive: true, force: true });
    }
    if ((await fs.readFile(source, "utf8")) !== code) throw new Error("源码已改变，请重试。");
    await workspace.update(current.bindingId, current.revision, (entry) => {
      (entry.presetUndo ??= {})[target.key] = previous.key;
      if (entry.initialSourceHash === hash(code)) entry.initialSourceHash = hash(updated);
    });
    if ((await fs.readFile(source, "utf8")) !== code) throw new Error("源码已改变，请重试。");
    await atomicWrite(source, updated);
  });
}

export async function undoPresetUpdate(root: string, binding: Binding): Promise<void> {
  const source = await safePath(root, binding.sourceFile);
  await withWorkspaceLock(path.join(root, ".accoding", "presets", "switch.lock"), async () => {
    const workspace = new WorkspaceStore(root);
    const current = await workspace.read(binding.bindingId);
    const code = await fs.readFile(source, "utf8");
    const active = sharedInclude(root, source, code);
    const previous = active && current.presetUndo?.[active.key];
    if (!active || !previous) throw new Error("没有可撤销的共享脚手架版本。");
    const directory = await sharedPresetPath(root, previous);
    await loadPreset(directory);
    const updated = replaceInclude(code, active.include, presetInclude(source, directory));
    if (current.initialSourceHash === hash(code))
      await workspace.update(current.bindingId, current.revision,
        (entry) => { entry.initialSourceHash = hash(updated); });
    if ((await fs.readFile(source, "utf8")) !== code) throw new Error("源码已改变，请重试。");
    await atomicWrite(source, updated);
  });
}
