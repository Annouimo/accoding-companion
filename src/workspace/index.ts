import fs from "node:fs/promises";
import { z } from "zod";
import {
  idSchema,
  type ContestSnapshot,
} from "../model";
import { problemSchema } from "./schema";
import { safePath, atomicWrite } from "./fs";
const rosterSchema = z.object({
  schemaVersion: z.literal(2),
  generatedBy: z.literal("betterAccoding"),
  id: idSchema,
  title: z.string(),
  directory: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  fetchedAt: z.string(),
  problems: z.array(
    z.object({
      id: idSchema,
      title: z.string(),
      label: z.string(),
      order: z.number().int().nonnegative(),
    }),
  ),
});
export type ContestRoster = z.infer<typeof rosterSchema>;
async function optional(file: string) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function readContestRoster(
  root: string,
  id: string,
): Promise<ContestRoster | undefined> {
  const legacy = await optional(await safePath(root,
    `contests/${idSchema.parse(id)}/contest.json`));
  const modern = await optional(await safePath(root,
    `.accoding/contests/${idSchema.parse(id)}.json`));
  const raw = modern ?? legacy;
  if (raw === undefined) return;
  const parsed = rosterSchema.safeParse(raw);
  if (!parsed.success || parsed.data.id !== id)
    throw Error("比赛元数据版本未知或损坏，原文件已保留。");
  return parsed.data;
}
export function validateContestSnapshot(
  snapshot: ContestSnapshot,
): ContestSnapshot {
  const result = z
    .object({
      id: idSchema,
      title: z.string(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      problems: z.array(problemSchema),
    })
    .parse(snapshot);
  const ids = new Set<string>();
  for (const p of result.problems) {
    if (p.target.kind !== "contest" || p.target.contestId !== result.id)
      throw Error("比赛题目来源不匹配。");
    if (ids.has(p.target.problemId)) throw Error("比赛题目 ID 重复。");
    ids.add(p.target.problemId);
  }
  return result;
}
export async function writeContestRoster(
  root: string,
  snapshot: ContestSnapshot,
) {
  snapshot = validateContestSnapshot(snapshot);
  const previous = await readContestRoster(root, snapshot.id);
  const roster: ContestRoster = {
    schemaVersion: 2,
    generatedBy: "betterAccoding",
    id: snapshot.id,
    title: snapshot.title,
    directory: previous?.directory,
    startTime: snapshot.startTime,
    endTime: snapshot.endTime,
    fetchedAt: new Date().toISOString(),
    problems: snapshot.problems.map((p) => {
      if (p.target.kind !== "contest" || p.target.contestId !== snapshot.id)
        throw Error("比赛题目来源不匹配。");
      return {
        id: p.target.problemId,
        title: p.title,
        label: p.label,
        order: p.target.contestOrder,
      };
    }),
  };
  if (new Set(roster.problems.map((p) => p.id)).size !== roster.problems.length)
    throw Error("比赛题目 ID 重复。");
  const destination = `.accoding/contests/${idSchema.parse(snapshot.id)}.json`;
  await atomicWrite(await safePath(root, destination),
    JSON.stringify(roster, null, 2));
}
