import fs from "node:fs/promises";
import path from "node:path";
import { bindingSchema } from "../workspace/schema";
import { WorkspaceStore } from "../workspace/store";
import { cTemplate, cppTemplate } from "../workspace/sources";
import { courseSettings, ensureContestDirectory, readableProblemDirectory } from "./workspaces";
import { readableStatement } from "../problems/statement";
import { loadPreset, renderHeader } from "./scaffold";
import { hash } from "../model";

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
  if (source === target || target.startsWith(source + path.sep))
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
      const legacyCode = await fs.readFile(
        path.resolve(source, previous.sourceFile), "utf8");
      if (!path.resolve(source, previous.sourceFile).startsWith(source + path.sep))
        throw new Error("旧源码路径超出工作区。");
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
      // Preserve existing migrated bindings: the call is idempotent.
      const binding = await store.import(previous.problem, directory);
      const destination = path.join(target, binding.sourceFile);
      const existing = await fs.readFile(destination, "utf8");
      const basic = language === "c" ? cTemplate : cppTemplate;
      if (existing !== basic && existing !== legacyCode)
        throw new Error("目标源码已有不同内容，不会覆盖。");
      if (existing === basic && legacyCode !== basic)
        await fs.writeFile(destination, legacyCode, "utf8");
      // Preserve cases (including locally modified inputs) through the new transactional store.
      if (previous.cases.length) {
        const fresh = await store.read(binding.bindingId);
        await store.saveCases(binding.bindingId, fresh.revision, previous.cases);
      }
      const outputDir = path.dirname(destination);
      const oldNotes = path.join(path.dirname(path.resolve(source, previous.sourceFile)), "problem.md");
      let notes = readableStatement(previous.problem);
      try { notes = await fs.readFile(oldNotes, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await fs.writeFile(path.join(outputDir, "题目.md"), notes, { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (language === "c") {
        const previousDir = path.dirname(path.resolve(source, previous.sourceFile));
        const oldPreset = path.join(previousDir, ".accoding", "scaffold", "manifest.json");
        try {
          const preset = await loadPreset(oldPreset);
          const oldHeader = await fs.readFile(
            path.join(previousDir, preset.manifest.headerFile), "utf8");
          if (oldHeader !== renderHeader(preset))
            throw new Error("旧 exam.h 存在人工修改，拒绝自动迁移此脚手架。");
          const folder = path.join(target, ".accoding", "scaffold", id);
          await fs.mkdir(folder, { recursive: true });
          for (const component of preset.manifest.components) {
            const file = path.resolve(folder, component.source);
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, preset.code.get(component.id)!, { flag: "wx" })
              .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
          }
          await fs.writeFile(path.join(folder, "manifest.json"),
            JSON.stringify(preset.manifest, null, 2) + "\n", { flag: "wx" })
            .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
          await fs.writeFile(path.join(folder, "expanded.h"),
            renderHeader(preset), { flag: "wx" })
            .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
          const rel = path.relative(outputDir, path.join(folder, "expanded.h"))
            .split(path.sep).join("/");
          const wrapper = "#ifndef ACCODING_EXAM_WRAPPER_H\n#define ACCODING_EXAM_WRAPPER_H\n" +
            '#include "' + rel + '"\n#endif\n';
          await fs.writeFile(path.join(outputDir, preset.manifest.headerFile),
            wrapper, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
              if (e.code !== "EEXIST") throw e;
            });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      // Migration of real work is not treated as a blank starter template.
      if (legacyCode === basic) {
        const mark = path.join(target, ".accoding", "initial-hashes", id + ".json");
        await fs.mkdir(path.dirname(mark), { recursive: true });
        await fs.writeFile(mark, JSON.stringify({ sourceHash: hash(legacyCode) }), { flag:"wx" })
          .catch((e: NodeJS.ErrnoException) => { if (e.code !== "EEXIST") throw e; });
      }
      report.migrated++;
    } catch (error) {
      report.skipped.push(id + ": " +
        (error instanceof Error ? error.message : String(error)));
    }
  }
  return report;
}
