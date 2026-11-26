import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CompilerUnavailableError } from "../judge/judge";

const filename = "docs/launcher/编译环境配置.html";
// The built CLI is dist/accoding.mjs; source execution is also supported.
export async function compilerGuidePath(): Promise<string> {
  const packaged = fileURLToPath(new URL("../" + filename, import.meta.url));
  const source = fileURLToPath(new URL("../../" + filename, import.meta.url));
  return await fs.access(packaged).then(() => packaged, () => source);
}

export async function compilerErrorMessage(error: unknown): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof CompilerUnavailableError)) return message;
  const hint = process.platform === "win32"
    ? "请检查 PATH 中的 GCC。若不熟悉配置，可使用课程提供的离线编译环境安装包。"
    : "请检查系统 PATH 中的编译器。";
  return message + "\n" + hint + "\n配置完成后请关闭并重新打开启动器。\n编译环境配置指引：" + await compilerGuidePath();
}
