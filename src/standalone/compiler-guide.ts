import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CompilerUnavailableError } from "../judge/judge";
import { interactive } from "./terminal";

const filename = "docs/launcher/编译环境配置.html";
// The built CLI is dist/accoding.mjs; source execution is also supported.
export async function compilerGuidePath(): Promise<string> {
  const packaged = fileURLToPath(new URL("../" + filename, import.meta.url));
  const source = fileURLToPath(new URL("../../" + filename, import.meta.url));
  return await fs.access(packaged).then(() => packaged, () => source);
}

function openGuide(file: string): Promise<void> {
  const command = process.platform === "win32" ? "explorer.exe" :
    process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    const child = spawn(command, [file], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

let attempted = false;

export async function compilerErrorMessage(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CompilerUnavailableError)) return message;
  const file = await compilerGuidePath();
  if (interactive() && !attempted) {
    attempted = true;
    try {
      await fs.access(file);
      await openGuide(file);
      return message + "\n已请求打开《编译环境配置》。配置后请重新启动 Companion。";
    } catch { /* A missing desktop/browser must not mask the compiler error. */ }
  }
  return message + "\n编译环境配置指引：" + file;
}
