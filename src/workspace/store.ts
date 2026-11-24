import * as fs from "node:fs/promises";
import { cTemplate, cppTemplate, defaultSourceFiles, languages } from "./sources";
import { extractSamples, readableStatement } from "../problems/statement";
import {
  readContestRoster,
  writeContestRoster,
} from "./index";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withWorkspaceLock } from "./lock";
import {
  recoverCaseTransaction,
  readExternalCaseEdits,
} from "./case-files";
import {
  bindingId,
  hash,
  caseSchema,
  type Binding,
  type Problem,
  type ContestSnapshot,
  type TestCase,
} from "../model";
import { problemSchema, bindingSchema } from "./schema";
export { ConflictError, atomicWrite, safePath } from "./fs";
import { ConflictError, atomicWrite, safePath } from "./fs";
export function newCase(name = "自定义用例"): TestCase {
  return {
    id: randomUUID(),
    name,
    source: "custom",
    input: "",
    expected: "",
    hasExpectedOutput: true,
    enabled: true,
    revision: 0,
    comparison: "trim-line-end",
    locallyModified: false,
  };
}
export class WorkspaceStore {
  private pending: Promise<unknown> = Promise.resolve();
  private observed = new Map<string, { revision: number; hash: string }>();
  constructor(readonly root: string) {}
  private file(id: string) {
    if (!/^((?:admin-)?problem-\d+|contest-\d+-\d+)$/.test(id))
      throw new Error("无效题目绑定。");
    return safePath(this.root, `.accoding/bindings/${id}.json`);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.pending.then(async () =>
      withWorkspaceLock(
        await safePath(this.root, ".accoding/write.lock"),
        action,
      ),
    );
    this.pending = task.catch(() => {});
    return task;
  }
  async list(): Promise<Binding[]> {
    return this.serialize(async () => {
      const ids = new Set<string>();
      for (const relative of [
        ".accoding/bindings",
        ".accoding/transactions",
      ]) {
        try {
          for (const file of await fs.readdir(
            await safePath(this.root, relative),
          ))
            if (/^((?:admin-)?problem-\d+|contest-\d+-\d+)\.json$/.test(file))
              ids.add(file.slice(0, -5));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const bindings: Binding[] = [];
      for (const id of ids)
        bindings.push(await this.remember(await this.readUnlocked(id)));
      return bindings;
    });
  }
  async read(id: string): Promise<Binding> {
    return this.serialize(async () =>
      this.remember(await this.readUnlocked(id)),
    );
  }
  private async remember(binding: Binding) {
    const raw = await fs.readFile(await this.file(binding.bindingId), "utf8");
    this.observed.set(binding.bindingId, {
      revision: binding.revision,
      hash: hash(raw),
    });
    return binding;
  }
  private async readUnlocked(id: string): Promise<Binding> {
    const file = await this.file(id);
    await recoverCaseTransaction(this.root, id);
    const rawJSON = await fs.readFile(file, "utf8");
    const raw = JSON.parse(rawJSON);
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error("工作区数据版本不兼容或已损坏，原文件已保留；请勿覆盖。");
    if (parsed.data.bindingId !== bindingId(parsed.data.problem.target))
      throw new Error("绑定来源不匹配。");
    await safePath(this.root, parsed.data.sourceFile);
    const binding = parsed.data;
    await this.ensureSources(binding.problem, binding.problemDirectory);
    const externalChanged = await readExternalCaseEdits(this.root, binding);
    const observed = this.observed.get(id);
    const metadataChanged = observed?.revision === binding.revision && observed.hash !== hash(rawJSON);
    if (metadataChanged) binding.revision++;
    const compact = Boolean(binding.fileHashes || binding.problem.statement.content ||
      binding.problem.samples.length || binding.comparisonDefaultsVersion !== 1);
    if (compact) {
      this.restoreMissingSamples(binding);
      if (binding.comparisonDefaultsVersion !== 1) {
        for (const test of [...binding.cases, ...(binding.deletedCases ?? [])])
          if (test.comparison === "exact") { test.comparison = "trim-line-end"; test.revision++; }
        binding.comparisonDefaultsVersion = 1;
      }
      binding.revision++;
    }
    if (!binding.initialSourceHash) {
      const mark = await safePath(this.root, ".accoding/initial-hashes/" + id + ".json");
      try {
        const legacy = JSON.parse(await fs.readFile(mark, "utf8")) as { sourceHash?: string };
        if (legacy.sourceHash && /^[a-f0-9]{64}$/.test(legacy.sourceHash))
          binding.initialSourceHash = legacy.sourceHash;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (compact || externalChanged || metadataChanged || binding.initialSourceHash !== raw.initialSourceHash) {
      if ((await fs.readFile(file, "utf8")) !== rawJSON)
        throw new ConflictError("读取期间元数据被外部修改，未覆盖文件。");
      await this.persist(file, binding);
    }
    return binding;
  }
  private async persist(file: string, binding: Binding, initialNotes?: string) {
    if (initialNotes !== undefined || binding.problem.statement.content) {
      const notes = await safePath(this.root,
        path.posix.join(path.posix.dirname(binding.sourceFile), "题目.md"));
      try { await fs.writeFile(notes, initialNotes ?? readableStatement(binding.problem), { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    binding.problem = {
      ...binding.problem,
      samples: [],
      statement: { ...binding.problem.statement, content: "" },
    };
    delete binding.fileHashes;
    for (const test of [...binding.cases, ...(binding.deletedCases ?? [])]) {
      delete test.inputFile;
      delete test.expectedOutputFile;
      if (!test.locallyModified && test.baseline?.input === test.input &&
          test.baseline.expected === test.expected) delete test.baseline;
    }
    await atomicWrite(file, JSON.stringify(binding, null, 2) + "\n");
  }

  private restoreMissingSamples(binding: Binding): boolean {
    const parsed = binding.problem.samples.length ? { samples: binding.problem.samples, warnings: [] } : extractSamples(
      binding.problem.statement.format,
      binding.problem.statement.content,
    );
    if (!parsed.samples.length || parsed.warnings.length) return false;
    binding.problem.samples = parsed.samples;
    binding.problem.warnings = binding.problem.warnings.filter(
      (warning) =>
        warning !== "公开样例未能完整配对，请检查题面并手动补充用例。",
    );
    for (const sample of parsed.samples) {
      if (
        binding.tombstones.includes(sample.key) ||
        binding.cases.some((c) => c.upstreamSampleKey === sample.key)
      )
        continue;
      binding.cases.push({
        ...newCase(`样例 ${sample.key.replace("sample-", "")}`),
        source: "sample",
        input: sample.input,
        expected: sample.expected,
        upstreamSampleKey: sample.key,
        baseline: { input: sample.input, expected: sample.expected },
      });
    }
    return true;
  }
  contestRoster(id: string) {
    return this.serialize(() => readContestRoster(this.root, id));
  }
  recordContest(snapshot: ContestSnapshot) {
    return this.serialize(() => writeContestRoster(this.root, snapshot));
  }
  markRemoved(binding: Binding) {
    if (binding.problem.target.kind !== "contest")
      throw Error("只有比赛绑定可以标记为移除。");
    if (binding.unavailable) return this.read(binding.bindingId);
    return this.update(binding.bindingId, binding.revision, (b) => {
      b.unavailable = {
        reason: "removed",
        checkedAt: new Date().toISOString(),
      };
    });
  }
  private async ensureSources(problem: Problem, directory?: string) {
    const config = JSON.parse(await fs.readFile(path.join(
      this.root, ".accoding", "workspace.json"), "utf8")) as {
        kind?: string; language?: "c" | "cpp";
      };
    if (config.kind !== "course" || !["c", "cpp"].includes(config.language || ""))
      throw new Error("课程工作区配置缺失或不兼容。");
    const files = directory ? { c: path.posix.join(directory, languages.c.file),
      cpp: path.posix.join(directory, languages.cpp.file) } : defaultSourceFiles(problem.target);
    const [relative, template] = config.language === "c"
      ? [files.c, cTemplate] : [files.cpp, cppTemplate];
    const file = await safePath(this.root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try { await fs.writeFile(file, template, { flag: "wx" }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return relative;
  }
  async import(problem: Problem, directory?: string, notes?: string): Promise<Binding> {
    return this.serialize(async () => {
      problem = problemSchema.parse(problem);
      const id = bindingId(problem.target);
      try {
        return await this.remember(await this.readUnlocked(id));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (directory) {
        const marker = await safePath(this.root, `${directory}/main.c`);
        if (!marker.endsWith(path.join(directory, languages.c.file)))
          throw new Error("Invalid problem source directory");
      }
      const config = JSON.parse(await fs.readFile(
        path.join(this.root, ".accoding", "workspace.json"), "utf8")) as {
          language?: "c" | "cpp";
        };
      const supported = problem.languages.some((value) => {
        const normalized = value.toLowerCase().replace(/\s+/g, "");
        const cpp = /cpp|c\+\+|g\+\+|clang\+\+|^gnu\+\+/.test(normalized);
        return config.language === "cpp" ? cpp :
          !cpp && (/^c(?:\d|$)|gcc|clang|gnu99|gnu11|gnu17/.test(normalized));
      });
      if (problem.languages.length && !supported)
        throw new Error("该题未提供工作区选择的编程语言，请使用其他工作区。");
      const sourceFile = await this.ensureSources(problem, directory);
      const binding: Binding = {
        schemaVersion: 2,
        comparisonDefaultsVersion: 1,
        bindingId: id,
        problem,
        sourceFile,
        ...(directory ? { problemDirectory: directory } : {}),
        fetchedAt: new Date().toISOString(),
        revision: 0,
        cases: problem.samples.map((s, i) => ({
          ...newCase(`样例 ${i + 1}`),
          source: "sample",
          upstreamSampleKey: s.key,
          input: s.input,
          expected: s.expected,
          baseline: { input: s.input, expected: s.expected },
        })),
        tombstones: [],
      };
      this.restoreMissingSamples(binding);
      await this.persist(await this.file(id), binding, notes);
      return this.remember(binding);
    });
  }
  async update(
    id: string,
    baseRevision: number,
    change: (binding: Binding) => void,
  ): Promise<Binding> {
    return this.serialize(async () => {
      const binding = await this.readUnlocked(id);
      const previousJSON = await fs.readFile(await this.file(id), "utf8");
      const observed = this.observed.get(id);
      if (
        binding.revision === baseRevision &&
        observed?.revision === baseRevision &&
        observed.hash !== hash(previousJSON)
      )
        throw new ConflictError(
          "元数据在外部发生更改，草稿已保留，请重新载入后核对。",
        );
      if (binding.revision !== baseRevision)
        throw new ConflictError(
          "用例已被其他窗口或外部编辑修改。草稿保留，请重新载入并核对。",
        );
      change(binding);
      binding.revision++;
      bindingSchema.parse(binding);
      await safePath(this.root, binding.sourceFile);
      if (await fs.readFile(await this.file(id), "utf8") !== previousJSON)
        throw new ConflictError("保存期间元数据被外部修改，未覆盖文件。");
      await this.persist(await this.file(id), binding);
      return this.remember(binding);
    });
  }
  async saveCases(
    id: string,
    baseRevision: number,
    cases: TestCase[],
  ): Promise<Binding> {
    const validated = z.array(caseSchema).max(500).parse(cases);
    if (new Set(validated.map((c) => c.id)).size !== validated.length)
      throw new Error("用例 ID 重复。");
    return this.update(id, baseRevision, (b) => {
      const old = new Map(b.cases.map((c) => [c.id, c]));
      b.deletedCases ??= [];
      for (const previous of b.cases) {
        if (!validated.some((c) => c.id === previous.id)) {
          b.deletedCases = b.deletedCases.filter((c) => c.id !== previous.id);
          b.deletedCases.push(previous);
          if (previous.upstreamSampleKey)
            b.tombstones.push(previous.upstreamSampleKey);
        }
      }
      b.cases = validated.map((next) => {
        const previous =
          old.get(next.id) ?? b.deletedCases?.find((c) => c.id === next.id);
        if (previous?.upstreamSampleKey)
          b.tombstones = b.tombstones.filter(
            (key) => key !== previous.upstreamSampleKey,
          );
        const baseline = previous?.baseline ?? (previous?.source === "sample"
          ? { input: previous.input, expected: previous.expected } : undefined);
        const changed =
          !previous ||
          ["input", "expected", "hasExpectedOutput", "comparison"].some(
            (k) => next[k as keyof TestCase] !== previous[k as keyof TestCase],
          );
        return {
          ...next,
          source:
            previous?.source ??
            (next.source === "imported" ? "imported" : "custom"),
          upstreamSampleKey: previous?.upstreamSampleKey,
          baseline,
          revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
          locallyModified: baseline
            ? next.input !== baseline.input ||
              next.expected !== baseline.expected
            : false,
        };
      });
      b.deletedCases = b.deletedCases
        .filter((c) => !b.cases.some((current) => current.id === c.id))
        .slice(-100);
    });
  }
  async sync(binding: Binding, problem: Problem) {
    problem = problemSchema.parse(problem);
    if (bindingId(problem.target) !== binding.bindingId)
      throw new Error("拒绝更换同步来源。");
    return this.update(binding.bindingId, binding.revision, (b) => {
      b.problem = problem;
      delete b.unavailable;
      b.fetchedAt = new Date().toISOString();
      for (const sample of problem.samples) {
        if (b.tombstones.includes(sample.key)) continue;
        const c = b.cases.find((x) => x.upstreamSampleKey === sample.key);
        if (!c) {
          b.cases.push({
            ...newCase(`样例 ${sample.key}`),
            source: "sample",
            input: sample.input,
            expected: sample.expected,
            upstreamSampleKey: sample.key,
            baseline: { input: sample.input, expected: sample.expected },
          });
          continue;
        }
        if (!c.locallyModified) {
          if (c.input !== sample.input || c.expected !== sample.expected)
            c.revision++;
          c.input = sample.input;
          c.expected = sample.expected;
        } else if (
          c.baseline?.input !== sample.input ||
          c.baseline?.expected !== sample.expected
        )
          b.problem.warnings.push(`${c.name}：官方样例更新，已保留本地修改。`);
        c.baseline = { input: sample.input, expected: sample.expected };
        c.locallyModified =
          c.input !== sample.input || c.expected !== sample.expected;
      }
    });
  }
}
