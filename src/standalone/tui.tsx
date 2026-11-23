import React, { useState } from "react";
import { Box, Text, render, useInput } from "ink";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { StandaloneWorkflow, ResolvedProblem } from "./workflow";
import { activityAccepted } from "./state";
import { ask } from "./terminal";
import { courseSettings } from "./workspaces";
import { chooseUpdateTargets, type UpdateMode } from "./preset-manager";

interface Item { id: string; label: string; note?: string }
interface MenuProps {
  title: string;
  breadcrumb: string[];
  items: Item[];
  detail?: string;
  onSelect: (id: string | undefined) => void;
}

function Menu({ title, breadcrumb, items, detail, onSelect }: MenuProps) {
  const [index, setIndex] = useState(0);
  useInput((input, key) => {
    if (key.upArrow) setIndex((n) => (n - 1 + items.length) % Math.max(items.length, 1));
    else if (key.downArrow) setIndex((n) => (n + 1) % Math.max(items.length, 1));
    else if (key.return) onSelect(items[index]?.id);
    else if (key.escape || key.backspace) onSelect(undefined);
    else if (input === "q" && !key.ctrl) onSelect(undefined);
    else if (/^[1-9]$/.test(input)) {
      const n = Number(input) - 1;
      if (items[n]) onSelect(items[n].id);
    }
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text dimColor>{breadcrumb.join("  ›  ")}</Text>
      <Text bold color="cyan">{title}</Text>
      <Text> </Text>
      {detail ? <Box marginBottom={1}><Text wrap="wrap">{detail}</Text></Box> : null}
      {items.map((item, i) => (
        <Box key={item.id} flexDirection="row" gap={1}>
          <Text color={index === i ? "cyan" : undefined}>
            {index === i ? "❯" : " "}
          </Text>
          <Text bold={index === i} color={index === i ? "cyan" : undefined}>
            {item.label}
          </Text>
          {item.note ? <Text dimColor> {item.note}</Text> : null}
        </Box>
      ))}
      <Text> </Text>
      <Text dimColor>↑↓ 选择   Enter 确定   Esc 返回   Q 退出/返回</Text>
    </Box>
  );
}

async function choose(
  title: string, breadcrumb: string[], items: Item[], detail?: string
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const mounted = render(<Menu title={title} breadcrumb={breadcrumb}
      items={items} detail={detail} onSelect={(id) => {
        if (settled) return;
        settled = true;
        mounted.unmount();
        resolve(id);
      }}/>, { exitOnCtrlC: false });
  });
}

async function transcript(run: () => Promise<unknown>): Promise<{
  output: string; result?: unknown; failed: boolean
}> {
  const old = { log: console.log, error: console.error, warn: console.warn };
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((x) => x instanceof Error ? x.message : String(x)).join(" "));
  };
  console.log = record;
  console.error = record;
  console.warn = record;
  let result: unknown, failed = false;
  try { result = await run(); }
  catch (error) { failed = true; record(error); }
  finally { Object.assign(console, old); }
  return { output: lines.slice(-35).join("\n") || "操作完成。", result, failed };
}

function crumbs(root: string, problem?: ResolvedProblem, section?: string): string[] {
  const items = [path.basename(root)];
  if (problem) {
    const relative = path.relative(root, path.dirname(problem.source));
    const folders = relative.split(path.sep).filter(Boolean);
    if (folders.length > 1) items.push(folders[0]);
    items.push(problem.binding.problem.label + " · " + problem.binding.problem.title);
  }
  if (section) items.push(section);
  return items;
}

async function openFolder(source: string): Promise<void> {
  const command = process.platform === "win32" ? "explorer.exe" :
    process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [path.dirname(source)], {
    detached: true, stdio: "ignore", windowsHide: true
  });
  child.unref();
}

async function pickProblem(
  app: StandaloneWorkflow, root: string,
  all: ResolvedProblem[]
): Promise<ResolvedProblem | undefined> {
  const state = await app.state.load();
  const account = app.session.user?.id ?? state.lastAccount ?? "offline";
  const ac = (problem: ResolvedProblem) =>
    activityAccepted(app.state.getActivity(state, root, problem.binding.bindingId, account));
  let showAccepted = false;
  for (;;) {
    const available = all.filter((x) => showAccepted || !ac(x));
    const acceptedCount = all.filter(ac).length;
    const entries: Item[] = available.map((p, i) => ({
      id: String(i), label: p.binding.problem.label + " · " + p.binding.problem.title,
      note: ac(p) ? "AC" : (
        app.state.getActivity(state, root, p.binding.bindingId, account).verdict || "未提交"
      )
    }));
    entries.push({
      id: "toggle", label: showAccepted ? "隐藏已 AC 题目" : "展开已 AC 题目",
      note: "(" + acceptedCount + ")"
    });
    const selected = await choose("选择题目", crumbs(root), entries);
    if (selected === undefined) return;
    if (selected === "toggle") { showAccepted = !showAccepted; continue; }
    const picked = available[Number(selected)];
    if (picked) {
      await app.state.rememberProblem(root, picked.binding.bindingId, account,
        { sourceFile: picked.source });
      return picked;
    }
  }
}

export async function startFullScreenTui(app: StandaloneWorkflow): Promise<void> {
  try { await app.account(false); } catch { /* Local workspaces are still usable. */ }
  for (;;) {
    const state = await app.state.load();
    const root = state.lastWorkspace;
    const initialized = Boolean(root && await fs.stat(path.join(root, ".accoding", "workspace.json"))
      .then(() => true, () => false));
    const all = initialized ? await app.list(root) : [];
    const account = app.session.user?.id ?? state.lastAccount ?? "offline";
    const current = all.find((p) =>
      app.state.isLastProblem(state, p.root, p.binding.bindingId, account)) ||
      all[0];
    const base = root ? path.basename(root) : "Accoding Companion";
    const header = current ? crumbs(root!, current) : [base];
    const entries: Item[] = current ? [
      { id: "test", label: "本地测试", note: path.basename(current.source) },
      { id: "submit", label: "直接提交" },
      { id: "folder", label: "打开代码文件夹" },
      { id: "pick", label: "切换题目" },
      { id: "contests", label: "课程 / 比赛总览" },
      { id: "importContest", label: "导入新比赛" },
      { id: "importProblem", label: "导入独立题目" },
      { id: "settings", label: "设置 / 工作区" },
      { id: "exit", label: "退出" }
    ] : [
      { id: "importContest", label: "导入比赛" },
      { id: "importProblem", label: "导入独立题目" },
      { id: "settings", label: "设置 / 切换工作区" },
      { id: "login", label: "登录 Accoding" },
      { id: "exit", label: "退出" }
    ];
    const active = current ? current.binding.problem.title + "\n" +
      (await courseSettings(root!)).language.toUpperCase() +
      " · " + current.source + "\n" +
      (app.state.getActivity(state, root!, current.binding.bindingId, account).verdict || "未提交") :
      "当前没有已导入的题目。";
    const action = await choose("Accoding Companion", header, entries,
      active + "\n登录：" + (app.session.user?.id || "未连接"));
    if (!action || action === "exit") return;
    if (action === "folder" && current) { await openFolder(current.source); continue; }
    if (action === "pick" && root) { await pickProblem(app, root, all); continue; }
    if (action === "test" && current) {
      const outcome = await transcript(() => app.test(current));
      const choice = await choose("本地测试结果", crumbs(root!, current, "本地测试"),
        outcome.result === true && !outcome.failed
          ? [{ id: "submit", label: "提交刚刚通过测试的源码" },
            { id: "back", label: "返回当前题目" }]
          : [{ id: "back", label: "返回修改代码" }], outcome.output);
      if (choice === "submit") {
        const confirmed = await choose("确认 OJ 提交", crumbs(root!, current),
          [{ id: "yes", label: "确认提交" }, { id: "no", label: "取消" }]);
        if (confirmed === "yes") {
          const result = await transcript(() =>
            app.submit(current, undefined, app.testedCode(current.source)));
          await choose("OJ 提交", crumbs(root!, current, "结果"),
            [{ id: "back", label: "返回题目" }], result.output);
        }
      }
      continue;
    }
    if (action === "submit" && current) {
      const confirmed = await choose("直接提交", crumbs(root!, current),
        [{ id: "yes", label: "展开并编译后提交（跳过样例）" },
         { id: "no", label: "取消" }]);
      if (confirmed === "yes") {
        const result = await transcript(() => app.submit(current));
        await choose("OJ 提交", crumbs(root!, current, "结果"),
          [{ id: "back", label: "返回题目" }], result.output);
      }
      continue;
    }
    if (action === "login") {
      const result = await transcript(() => app.login());
      await choose("登录结果", [base, "账号"], [{ id: "back", label: "返回" }], result.output);
      continue;
    }
    if (action === "importContest" || action === "importProblem") {
      const id = await ask(action === "importContest" ? "比赛 ID 或链接" : "题目 ID 或链接");
      if (id) {
        const result = await transcript(() =>
          action === "importContest" ? app.importContest(id) : app.importProblem(id));
        await choose("导入结果", [base, "导入"], [{ id: "back", label: "返回" }], result.output);
      }
      continue;
    }
    if (action === "contests" && root) {
      const contests = new Map<string, ResolvedProblem[]>();
      for (const p of all) {
        const target = p.binding.problem.target;
        const id = target.kind === "contest" ? target.contestId : "独立题目";
        const list = contests.get(id) || [];
        list.push(p); contests.set(id, list);
      }
      const ids = [...contests.keys()];
      const selected = await choose("课程总览", [base], ids.map((id, i) =>
        ({ id: String(i), label: id === "独立题目" ? id : "比赛 " + id,
          note: (contests.get(id)?.length || 0) + " 题" })));
      if (selected !== undefined) await pickProblem(app, root, contests.get(ids[Number(selected)]) || []);
      continue;
    }
    if (action === "settings") {
      const selected = await choose("设置", [base, "设置"], [
        { id: "workspace", label: "选择 / 新建课程工作区" },
        { id: "preset", label: "脚手架版本和题目更新（本地）" },
        { id: "sync", label: "同步远程题目" },
        { id: "status", label: "查询 OJ 提交状态" },
        { id: "login", label: "登录 / 切换账号" },
        { id: "logout", label: "退出登录" }
      ], "软件和脚手架的联网检查与下载，请运行安装器。");
      if (!selected) continue;
      let result: { output: string } = {output:"未执行操作。"};
      if (selected === "workspace") {
        const known = (await app.state.load()).recentWorkspaces || [];
        const choice = await choose("课程工作区", [base, "工作区"], [
          ...known.map((dir, index) => ({id:String(index),label:path.basename(dir),note:dir})),
          {id:"new",label:"添加已有工作区 / 新建课程文件夹"}
        ]);
        const raw = choice === "new" ?
          await ask("课程文件夹（可拖入路径）", root) :
          choice !== undefined ? known[Number(choice)] : undefined;
        if (raw) result = await transcript(() => app.courseRoot(raw));
      } else if (selected === "preset") {
        if (!root) {
          result = { output: "请先创建课程工作区。" };
        } else {
          const versions = await app.installedPresetVersions();
          if (!versions.length) {
            result = { output: "尚无通过安装器下载的脚手架版本。\n请运行 install.sh 或 install.ps1 下载。" };
          } else {
            const version = await choose("选择本机脚手架版本", [base,"脚手架"],
              versions.map(v => ({id:v.version,label:"C Exam Kit " + v.version})));
            if (version) {
              const act = await choose("版本 "+version, [base,"脚手架",version], [
                { id:"default", label:"设为课程工作区默认版本（用于新题目）" },
                { id:"empty", label:"更新所有空题目（推荐）" },
                { id:"unaccepted", label:"更新所有未 AC 题目" },
                { id:"all", label:"更新所有题目" },
                { id:"selected", label:"自选更新题目" },
                { id:"undo", label:"撤销某道题的上一次脚手架更新" }
              ]);
              if (act === "default") {
                result = await transcript(() => app.setWorkspacePreset(version, root));
              } else if (act === "undo") {
                const chosen = await choose("选择要回退的题目", [base,"脚手架","回退"],
                  all.filter(p=>p.source.endsWith(".c")).map(p=>({
                    id:p.binding.bindingId,
                    label:p.binding.problem.label + " · " + p.binding.problem.title
                  })));
                if (chosen) result = await transcript(() => app.undoQuestionPreset(chosen,root));
              } else if (act && ["empty","unaccepted","all","selected"].includes(act)) {
                const mode = act as UpdateMode;
                let ids: string[] = [];
                if (mode === "selected") {
                  const checked = new Set<string>();
                  const candidates = all.filter(p=>p.source.endsWith(".c"));
                  for (;;) {
                    const item = await choose("空格选择的等效方式：Enter 勾选/取消",
                      [base,"脚手架","自选题目"],[
                      {id:"done",label:"确认选择 ("+checked.size+")"},
                      ...candidates.map(p=>({
                        id:p.binding.bindingId,
                        label:(checked.has(p.binding.bindingId)?"[x] ":"[ ] ")+
                          p.binding.problem.label+" · "+p.binding.problem.title
                      }))
                    ]);
                    if (!item || item==="done") break;
                    if (checked.has(item)) checked.delete(item); else checked.add(item);
                  }
                  ids=[...checked];
                }
                const state = await app.state.load();
                const user = app.session.user?.id || state.lastAccount || "offline";
                const preview = await chooseUpdateTargets(root,
                  all.map(x=>x.binding),mode,
                  b=>app.state.getActivity(state,root,b.bindingId,user),ids);
                const listed = preview.targets.slice(0,15)
                  .map(b=>b.problem.label+" · "+b.problem.title).join("\n");
                const agree = await choose("脚手架更新预览", [base,"脚手架","预览"], [
                  {id:"yes",label:"确认更新 "+preview.targets.length+" 道题"},
                  {id:"no",label:"取消"}
                ], listed+"\n状态未知、未纳入："+
                  preview.excludedUnknown+" 道。将保留源码与旧组件备份。");
                if (agree==="yes" && preview.targets.length) {
                  result=await transcript(async()=>{
                    const r=await app.updateQuestionPresets(version,mode,ids,root);
                    console.log("更新成功："+r.updated+" 道；状态未知："+r.excludedUnknown);
                    for(const err of r.errors) console.log("跳过："+err);
                  });
                }
              }
            }
          }
        }
      } else if (selected === "sync") result = await transcript(() => app.sync());
      else if (selected === "status") result = await transcript(() => app.status(root, true));
      else if (selected === "login") result = await transcript(() => app.login());
      else if (selected === "logout") result = await transcript(() => app.logout());
      await choose("操作结果", [base, "设置"], [{ id:"back", label:"返回" }], result.output);
    }
  }
}
