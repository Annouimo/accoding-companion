import { createRequire as createNodeRequire } from "node:module";

const runtimeRequire = createNodeRequire(import.meta.url);

/** Resolve relative to the actual bundled CLI, not the caller's cwd or global npm. */
export function resolvePackageFile(name: string, file: string): string | undefined {
  try { return runtimeRequire.resolve(name + "/" + file); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") return;
    throw error;
  }
}
