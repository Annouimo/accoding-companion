import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bundledPreset, type InstalledPreset } from "./preset-manager";
import { resolvePackageFile } from "./installed-packages";

const exec = promisify(execFile);
const PRESET = "@annouimo/c-exam-kit-preset";
const OBSERVER = "@annouimo/c-observer";
type Status = "ready" | "not-installed" | "unsupported-platform" | "incompatible" | "invalid";
export interface ComponentInfo {
  name: string;
  package: string;
  version?: string;
  required: boolean;
  status: Status;
}

export function observerBinaryFromManifest(root: string, value: unknown, platform = process.platform as string, arch = process.arch as string): string {
  const data = value as { schemaVersion?: number; sessionSchemaVersions?: number[]; platforms?: Record<string, { executable?: string }> } | null;
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.sessionSchemaVersions) || !data.sessionSchemaVersions.includes(1))
    throw new Error("C Observer 软件包协议不兼容。");
  const executable = data.platforms?.[platform + "-" + arch]?.executable;
  if (typeof executable !== "string") throw new Error("当前平台尚未提供 C Observer。");
  const binary = path.resolve(root, executable);
  const relative = path.relative(root, binary);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("C Observer 软件包路径无效。");
  return binary;
}

export async function probeObserverBinary(binary: string): Promise<{version?: string; sessionSchemaVersions?: number[]; backends?: string[]}> {
  if (!(await fs.stat(binary)).isFile()) throw new Error("找不到 C Observer 可执行文件。");
  const { stdout } = await exec(binary, ["--capabilities"], { timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const capability = JSON.parse(stdout);
  if (!Array.isArray(capability?.sessionSchemaVersions) || !capability.sessionSchemaVersions.includes(1) ||
      !Array.isArray(capability.backends) || !capability.backends.length)
    throw new Error("C Observer 当前版本不支持本机观察协议或后端。");
  return capability;
}

/** Inspect only the installed npm dependency, not a developer override. */
async function observerInfo(resolve = resolvePackageFile): Promise<ComponentInfo> {
  const result: ComponentInfo = {name:"C Observer",package:OBSERVER,required:false,status:"not-installed"};
  try {
    const metadata = resolve(OBSERVER,"package.json");
    if (!metadata) return result;
    result.status = "invalid";
    const pkg = JSON.parse(await fs.readFile(metadata,"utf8"));
    if (pkg.name !== OBSERVER || typeof pkg.version !== "string") return result;
    result.version = pkg.version;
    const manifest = resolve(OBSERVER,"manifest.json");
    if (!manifest) return result;
    const data = JSON.parse(await fs.readFile(manifest,"utf8"));
    if (data?.version !== result.version) return result;
    if (data.schemaVersion !== 1 || !Array.isArray(data.sessionSchemaVersions) || !data.sessionSchemaVersions.includes(1)) {
      result.status = "incompatible"; return result;
    }
    if (!data.platforms?.[process.platform+"-"+process.arch]) {
      result.status = "unsupported-platform"; return result;
    }
    const binary = observerBinaryFromManifest(path.dirname(manifest),data);
    const capabilities = await probeObserverBinary(binary);
    if (capabilities.version !== result.version) { result.status = "incompatible"; return result; }
    result.status = "ready";
  } catch { /* optional broken dependency is reported, not fatal */ }
  return result;
}

/** No network, OJ session, global npm command, compiler probe, or state writes. */
export async function installationInfo(version: string, deps: {
  preset?: () => Promise<InstalledPreset | undefined>;
  resolve?: typeof resolvePackageFile;
} = {}) {
  const preset: ComponentInfo = {name:"C Exam Kit",package:PRESET,required:true,status:"not-installed"};
  try {
    const installed = await (deps.preset ?? bundledPreset)();
    if (installed) { preset.version=installed.version; preset.status="ready"; }
  } catch { preset.status="invalid"; }
  const components=[preset,await observerInfo(deps.resolve)];
  return {schemaVersion:1,version,ready:components.every(c=>!c.required||c.status==="ready"),components};
}
