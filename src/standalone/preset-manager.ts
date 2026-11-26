import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "./state";
import { resolvePackageFile } from "./observer";
import { loadPreset, renderHeader, assembleC, quotedIncludes, PRESET_MANUAL, PRESET_REFERENCE, type LoadedPreset } from "./scaffold";
import { atomicWrite, safePath } from "../workspace/fs";
import { withWorkspaceLock } from "../workspace/lock";
import { compile, type Toolchain } from "../judge/judge";
import { WorkspaceStore } from "../workspace/store";
import { cTemplate, languages } from "../workspace/sources";
import { hash, type Binding } from "../model";

const DATA_PACKAGE = "@routilet/c-exam-kit";
const LEGACY_DATA_PACKAGE = "@annouimo/c-exam-kit-preset";
const DATA_PACKAGES = [DATA_PACKAGE, LEGACY_DATA_PACKAGE];
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

export interface InstalledPreset {
  version: string;
  preset: LoadedPreset;
}

const execFileAsync = promisify(execFile);

async function globalPresets(): Promise<InstalledPreset[]> {
  const found: InstalledPreset[] = [];
  const add = (preset?: InstalledPreset) => {
    if (preset && !found.some((entry) => entry.version === preset.version)) found.push(preset);
  };
  // npm resolves dependencies relative to this package, even if a legacy
  // launcher installs another version at the top level.
  if (process.env.ACCODING_PRESET_LEGACY_ONLY !== "1") {
    for (const name of DATA_PACKAGES) {
      const dependency = resolvePackageFile(name, "package.json");
      if (dependency) add(await readInstalledPreset(path.dirname(dependency)));
    }
  }
  const managed = process.env.ACCODING_PRESET_PACKAGE;
  if (managed && path.isAbsolute(managed)) {
    add(await readInstalledPreset(managed));
    return found;
  }
  let root: string;
  try {
    const windows = process.platform === "win32";
    const { stdout } = await execFileAsync(
      windows ? process.env.ComSpec || "cmd.exe" : "npm",
      windows ? ["/d", "/s", "/c", "npm.cmd root --global"] : ["root", "--global"],
      { timeout: 5000, windowsHide: true },
    );
    root = stdout.trim();
  } catch {
    // A standalone binary can still read coursework and older local installs without npm.
    return found;
  }
  if (path.isAbsolute(root)) {
    for (const name of DATA_PACKAGES) add(await readInstalledPreset(path.join(root, name)));
  }
  return found;
}

async function readInstalledPreset(packageRoot: string): Promise<InstalledPreset | undefined> {
  let info: { name?: string; version?: string };
  try {
    info = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const manifestPath = path.join(packageRoot, "preset", "manifest.json");
  if (!info.name || !DATA_PACKAGES.includes(info.name) || !info.version || !VERSION.test(info.version))
    throw new Error("脚手架包元数据无效：" + packageRoot);
  try {
    return { version: info.version, preset: await loadPreset(manifestPath) };
  } catch (error) {
    throw new Error("脚手架包损坏：" + info.version, { cause: error });
  }
}

async function legacyPreset(version: string): Promise<InstalledPreset | undefined> {
  for (const name of DATA_PACKAGES) {
    const folder = path.join(dataDirectory(), "presets", version, "node_modules", name);
    const preset = await readInstalledPreset(folder);
    if (preset?.version === version) return preset;
  }
}

/** Prefer the npm global package. Older per-version installs are a migration fallback. */
export async function installedPresets(): Promise<InstalledPreset[]> {
  const global = await globalPresets();
  if (global.length) return global;
  let names: string[];
  try { names = await fs.readdir(path.join(dataDirectory(), "presets")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found = await Promise.all(names.filter((name) => VERSION.test(name)).map(legacyPreset));
  return found.filter((preset) => preset !== undefined)
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}

export async function presetForVersion(version: string): Promise<InstalledPreset> {
  if (!VERSION.test(version)) throw new Error("无效的脚手架版本号。");
  const global = (await globalPresets()).find((entry) => entry.version === version);
  if (global) return global;
  const managed = process.env.ACCODING_PRESET_PACKAGE;
  if (managed && path.isAbsolute(managed) && /^0\.6\.(?:9|[1-9][0-9]+)$/.test(version)) {
    const candidate = await readInstalledPreset(managed);
    if (candidate?.version === version) return candidate;
  }
  const legacy = await legacyPreset(version);
  if (legacy) return legacy;
  throw new Error("此脚手架版本尚未安装。请安装对应版本的资源包（新发行使用 " + DATA_PACKAGE + "@" + version + "，历史版本可使用 " + LEGACY_DATA_PACKAGE + "@" + version + "）");
}

export async function setCoursePresetVersion(root: string, version: string): Promise<void> {
  const installed = await presetForVersion(version);
  await saveSharedPreset(root, installed.preset, version);
  const file = await safePath(root, ".accoding/workspace.json");
  await withWorkspaceLock(path.join(path.dirname(file), "write.lock"), async () => {
    const config = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    if (config.kind !== "course" || config.language !== "c" ||
      (config.languageId ?? languages.c.id) !== (installed.preset.manifest.languageId ?? languages.c.id))
      throw new Error("资源包与课程语言不匹配。");
    config.presetVersion = version;
    await atomicWrite(file, JSON.stringify(config, null, 2) + "\n");
  });
}

export type UpdateMode = "empty" | "selected";

async function sourceStatus(root: string, binding: Binding, source: string, code: string) {
  let initial = binding.initialSourceHash;
  if (!initial) {
    const mark = await safePath(root, ".accoding/initial-hashes/" + binding.bindingId + ".json");
    try {
      initial = (JSON.parse(await fs.readFile(mark, "utf8")) as { sourceHash?: string }).sourceHash;
    } catch (error) {
      if (!["ENOENT", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "") &&
          !(error instanceof SyntaxError)) throw error;
    }
  }
  if (initial) return hash(code) === initial ? "untouched" : "edited";
  const include = sharedInclude(root, source, code);
  return include && code === '#include "' + include.include + '"\n' + cTemplate ? "untouched" : "unknown";
}

export async function chooseUpdateTargets(
  root: string, bindings: Binding[], mode: UpdateMode, selected: string[] = [], version?: string
): Promise<{ targets: Binding[]; retained: number; edited: number; unknown: number }> {
  const eligible = bindings.filter(b => !b.unavailable && /\.c$/i.test(b.sourceFile));
  const targets: Binding[] = [];
  let edited = 0, unknown = 0;
  for (const binding of eligible) {
    if (mode === "selected" && !selected.includes(binding.bindingId)) continue;
    const source = await safePath(root, binding.sourceFile);
    const code = await fs.readFile(source, "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (code !== undefined && version && sharedInclude(root, source, code)?.key === version) continue;
    const status = code === undefined ? "unknown" :
      mode === "selected" ? "untouched" : await sourceStatus(root, binding, source, code);
    if (status === "untouched") targets.push(binding);
    else if (status === "edited") edited++;
    else unknown++;
  }
  return { targets, retained: edited + unknown, edited, unknown };
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
    let existing: LoadedPreset | undefined;
    try {
      existing = await loadPreset(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (presetFingerprint(existing) !== fingerprint)
        throw new Error("已保存的脚手架版本与安装包内容不一致：" + key);
      if (existing.manual === undefined && preset.manual !== undefined) {
        const manualFile = await safePath(destination, PRESET_MANUAL);
        await atomicWrite(manualFile, preset.manual);
      }
      if (existing.reference === undefined && preset.reference !== undefined)
        await atomicWrite(await safePath(destination, PRESET_REFERENCE), preset.reference);
      return;
    }
    const stage = path.join(base, ".stage-" + randomUUID());
    try {
      await fs.mkdir(stage);
      for (const component of preset.manifest.components) {
        if (!component.source) continue;
        const target = await safePath(stage, component.source);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, preset.code.get(component.id)!, { flag: "wx" });
      }
      await fs.writeFile(path.join(stage, "manifest.json"),
        JSON.stringify(preset.manifest, null, 2) + "\n");
      await fs.writeFile(path.join(stage, "expanded.h"), renderHeader(preset));
      if (preset.manual !== undefined)
        await fs.writeFile(path.join(stage, PRESET_MANUAL), preset.manual);
      if (preset.reference !== undefined)
        await fs.writeFile(path.join(stage, PRESET_REFERENCE), preset.reference);
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
  root: string, binding: Binding, installed: InstalledPreset, toolchain: Toolchain, onlyUntouched = false
): Promise<boolean> {
  const source = await safePath(root, binding.sourceFile);
  if (path.extname(source).toLowerCase() !== ".c") throw new Error("C Exam Kit 需要 C 源文件。");
  const preset = installed.preset;
  const target = await saveSharedPreset(root, preset, installed.version);
  const nextInclude = presetInclude(source, target.directory);
  return withWorkspaceLock(path.join(root, ".accoding", "presets", "switch.lock"), async () => {
    const workspace = new WorkspaceStore(root);
    const current = await workspace.read(binding.bindingId);
    const code = await fs.readFile(source, "utf8");
    if (onlyUntouched && await sourceStatus(root, current, source, code) !== "untouched")
      throw new Error("源码已改动或无法确认初始内容。");
    const previous = await previousPreset(root, current, source, code);
    if (!previous) throw new Error("此题没有可切换的脚手架引用。");
    if (previous.key === target.key && previous.include === nextInclude) return false;
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
      if (onlyUntouched || entry.initialSourceHash === hash(code)) entry.initialSourceHash = hash(updated);
    });
    if ((await fs.readFile(source, "utf8")) !== code) throw new Error("源码已改变，请重试。");
    await atomicWrite(source, updated);
    return true;
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
