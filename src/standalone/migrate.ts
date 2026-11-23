import fs from "node:fs/promises";
import path from "node:path";
import { bindingSchema } from "../workspace/schema";
import { WorkspaceStore } from "../workspace/store";
import { cTemplate, cppTemplate } from "../workspace/sources";
import { courseSettings, ensureContestDirectory, readableProblemDirectory } from "./workspaces";
import { readableStatement } from "../problems/statement";
import { loadPreset, renderHeader } from "./scaffold";
import { hash } from "../model";
import { atomicWrite } from "../workspace/fs";
import { saveSharedPreset, presetInclude } from "./preset-manager";

export interface MigrationReport {
  migrated: number;
  skipped: string[];
}

/**
 * Non-destructive, opt-in import of legacy standalone workspace files.
 * Source and tests are copied, never moved or deleted from the old root.
 * Unrecognized formats/conflicting new files are reported and left alone.
 */
export async function migrateLegacyWorkspace(
  sourceRoot: string, targetRoot: string, language: "c" | "cpp"
): Promise<MigrationReport> {
  const source = path.resolve(sourceRoot), target = path.resolve(targetRoot);
  if (source === target || target.startsWith(source + path.sep) ||
      source.startsWith(target + path.sep))
    throw new Error("新课程工作区必须位于旧工作区之外。");
  const bindingsDir = path.join(source, ".better-accoding", "bindings");
  const stat = await fs.stat(bindingsDir);
  if (!stat.isDirectory()) throw new Error("此目录不是受支持的旧版 Accoding 工作区。");
  let files = (await fs.readdir(bindingsDir)).filter(name =>
    /^((?:admin-)?problem-\d+|contest-\d+-\d+)\.json$/.test(name));
  files = files.sort();
  const data = [];
  // Preflight all bindings before creating anything in target.
  for (const name of files) {
    const raw = JSON.parse(await fs.readFile(path.join(bindingsDir, name), "utf8"));
    data.push(bindingSchema.parse(raw));
  }
  if (!data.length) throw new Error("旧工作区没有可迁移的题目。");
  await fs.mkdir(target, { recursive: true });
  await courseSettings(target, language);
  const store = new WorkspaceStore(target);
  const report: MigrationReport = { migrated: 0, skipped: [] };
  for (const previous of data) {
    const id = previous.bindingId;
    try {
      if ((language === "c" && !previous.sourceFile.endsWith(".c")) ||
          (language === "cpp" && !previous.sourceFile.endsWith(".cpp")))
        throw new Error("源文件语言与新工作区不同，请迁入对应语言的课程工作区。");
      const oldSourcePath = path.resolve(source, previous.sourceFile);
      if (!oldSourcePath.startsWith(source + path.sep))
        throw new Error("旧源码路径超出工作区。");
      const legacyCode = await fs.readFile(oldSourcePath, "utf8");
      let parent: string | undefined;
      if (previous.problem.target.kind === "contest") {
        const contestId = previous.problem.target.contestId;
        let title = path.basename(source);
        for (const roster of [
          path.join(source, ".better-accoding", "rosters", contestId + ".json"),
          path.join(source, "contests", contestId, "contest.json")
        ]) {
          try {
            const raw = JSON.parse(await fs.readFile(roster, "utf8"));
            if (typeof raw.title === "string" && raw.id === contestId) {
              title = raw.title; break;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        parent = await ensureContestDirectory(target, contestId, title);
      }
      const directory = await readableProblemDirectory(target, previous.problem, parent);
      const previousDir = path.dirname(path.resolve(source, previous.sourceFile));
      let notes = readableStatement(previous.problem);
      for (const file of ["题目.md", "problem.md"]) {
        try { notes = await fs.readFile(path.join(previousDir, file), "utf8"); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      const binding = await store.import(previous.problem, directory, notes);
      const destination = path.join(target, binding.sourceFile);
      const existing = await fs.readFile(destination, "utf8");
      const basic = language === "c" ? cTemplate : cppTemplate;
      let migratedCode = legacyCode;
      if (language === "c") {
        const oldPreset = path.join(previousDir, ".accoding", "scaffold", "manifest.json");
        try {
          const preset = await loadPreset(oldPreset);
          const oldHeader = await fs.readFile(path.join(previousDir, preset.manifest.headerFile), "utf8");
          if (oldHeader !== renderHeader(preset))
            throw new Error("旧 exam.h 存在人工修改，拒绝自动迁移此脚手架。");
          const shared = await saveSharedPreset(target, preset);
          const include = presetInclude(destination, shared.directory);
          const legacy = '#include "' + preset.manifest.headerFile + '"';
          migratedCode = migratedCode.replace(legacy, '#include "' + include + '"');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (existing !== basic && existing !== migratedCode)
        throw new Error("目标源码已有不同内容，不会覆盖。");
      if (existing === basic && migratedCode !== basic) await atomicWrite(destination, migratedCode);
      const fresh = await store.read(binding.bindingId);
      await store.update(binding.bindingId, fresh.revision, (entry) => {
        if (previous.cases.length) entry.cases = previous.cases;
        if (previous.deletedCases) entry.deletedCases = previous.deletedCases;
        entry.tombstones = previous.tombstones;
        if (legacyCode === basic) entry.initialSourceHash = hash(migratedCode);
      });
      report.migrated++;
    } catch (error) {
      report.skipped.push(id + ": " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  return report;
}
