import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";
import { normalizeOutput } from "../judge/judge";
import type { Comparison } from "../model";
import type { SampleCaseReport, SampleTestReport } from "./workflow";
import { parseCompilerDiagnostics, warningCount } from "./compiler-diagnostics";
import { lineDiff, type DiffPart } from "./line-diff";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function terminalText(text: string) {
  return text.replace(/\t/g, "→").replace(/[\x00-\x1f\x7f-\x9f]/g, "�");
}

function windowOf(text: string, width: number, offset = 0) {
  if (/^[\x20-\x7e]*$/.test(text)) {
    const part = text.slice(offset, offset + width);
    return offset + width < text.length ? part.slice(0, -1) + "…" : part;
  }
  let result = "", position = 0, used = 0, last = "", clipped = false;
  for (const { segment } of segmenter.segment(text)) {
    const cells = stringWidth(segment);
    position += cells;
    if (position - cells < offset) continue;
    if (used + cells > width) { clipped = true; break; }
    result += segment;
    used += cells;
    last = segment;
  }
  if (!clipped) return result;
  if (used < width) return result + "…";
  return result.slice(0, -last.length) + "…";
}

function outputLines(text: string, comparison: Comparison) {
  const normalized = normalizeOutput(text, comparison);
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const last = lines.pop()!;
  if (comparison === "exact") {
    for (let index = 0; index < lines.length; index++) lines[index] += "\n";
  }
  if (last) lines.push(last);
  return lines;
}

function outcome(entry: SampleCaseReport) {
  switch (entry.status) {
    case "PASS": return "通过";
    case "FAIL": return "输出不符";
    case "RE": return "运行异常 · " + (entry.signal ?? ("退出码 " + entry.exitCode));
    case "TIMEOUT": return "运行超时";
    case "OUTPUT_LIMIT": return "超出输出限制";
    case "CANCELLED": return "已取消";
    case "UNCHECKED": return "无预期输出";
  }
}

function outputCell(lines: string[], index: number) {
  if (index === lines.length) return "〈输出已结束〉";
  if (index > lines.length) return "—";
  const value = lines[index];
  return (value.endsWith("\n") ? terminalText(value.slice(0, -1)) + "↵" : terminalText(value)) ||
    "〈空行〉";
}

type View = "sample" | "diagnostic" | "log";
type Position = { top?: number; offset?: number; anchor?: number; raw?: boolean };

function visiblePart(part: DiffPart): DiffPart {
  return { ...part, text: terminalText(part.text.replace(/\n/g, "↵"))
    .replace(/ /g, part.changed ? "·" : " ") };
}
function clippedParts(parts: DiffPart[], width: number, offset: number): DiffPart[] {
  let position = 0, used = 0;
  const result: DiffPart[] = [];
  let clipped = false;
  outer: for (const part of parts) {
    if (/^[\x20-\x7e]*$/.test(part.text)) {
      const skip = Math.min(part.text.length, Math.max(0, offset - position));
      const take = Math.min(part.text.length - skip, width - used);
      if (take) result.push({text:part.text.slice(skip, skip + take), changed:part.changed});
      used += take; position += part.text.length;
      if (skip + take < part.text.length) { clipped = true; break; }
      continue;
    }
    for (const {segment} of segmenter.segment(part.text)) {
      const cells = stringWidth(segment);
      const start = position; position += cells;
      if (start < offset) continue;
      if (used + cells > width) { clipped = true; break outer; }
      const last = result[result.length - 1];
      if (last && last.changed === part.changed) last.text += segment;
      else result.push({text: segment, changed: part.changed});
      used += cells;
    }
  }
  if (clipped && used < width) result.push({ text: "…", changed: false });
  if (used < width - (clipped && used < width ? 1 : 0))
    result.push({text: " ".repeat(width - used - (clipped && used < width ? 1 : 0)), changed: false});
  return result;
}
function rowParts(a: string[], b: string[], index: number): [DiffPart[], DiffPart[]] {
  if (index >= a.length || index >= b.length)
    return [[{text: outputCell(a, index), changed: true}], [{text: outputCell(b, index), changed: true}]];
  if (a[index] === b[index])
    return [[{text: outputCell(a, index), changed: false}], [{text: outputCell(b, index), changed: false}]];
  const [left, right] = lineDiff(a[index], b[index]);
  return [left.length ? left.map(visiblePart) : [{text: "〈空行〉", changed: true}],
    right.length ? right.map(visiblePart) : [{text: "〈空行〉", changed: true}]];
}
function changeColumn(parts: DiffPart[]) {
  let width = 0;
  for (const p of parts) {
    if (p.changed && p.text.length) return width;
    width += stringWidth(p.text);
  }
  return Infinity;
}
function wrapText(text: string, width: number) {
  const lines: string[] = [];
  for (const source of text.split(/\r?\n/)) {
    let line = "", used = 0;
    for (const {segment} of segmenter.segment(terminalText(source))) {
      const size = stringWidth(segment);
      if (used && used + size > width) { lines.push(line); line = ""; used = 0; }
      line += segment; used += size;
    }
    lines.push(line);
  }
  return lines;
}

export interface SampleOutputState {
  selected: number;
  diagnosticIndex: number;
  view: View;
  positions: Record<string, Position>;
}
export function SampleOutput({ report, onBack, initial, onObserve, observationError }: {
  report: SampleTestReport; onBack: () => void;
  initial?: SampleOutputState;
  onObserve?: (entry: SampleCaseReport, state: SampleOutputState) => void;
  observationError?: string;
}) {
  const cases = report.kind === "samples" ? report.cases : [];
  const diagnostics = report.diagnostics ?? (report.kind === "compile" ? parseCompilerDiagnostics(report.output) : []);
  const firstFailure = cases.findIndex(entry => entry.status !== "PASS");
  const [selected, setSelected] = useState(initial?.selected ?? Math.max(0, firstFailure));
  const [diagnosticIndex, setDiagnosticIndex] = useState(initial?.diagnosticIndex ?? 0);
  const hasLogs = cases.some(c => c.stderr || !["PASS", "FAIL"].includes(c.status));
  const views: View[] = [
    ...(cases.length ? ["sample" as const] : []),
    ...(diagnostics.length ? ["diagnostic" as const] : []),
    ...(hasLogs ? ["log" as const] : [])
  ];
  const [view, setView] = useState<View>(initial?.view ?? (report.kind === "compile" ? "diagnostic" :
    firstFailure >= 0 && !["PASS", "FAIL"].includes(cases[firstFailure].status) ? "log" : "sample"));
  const [positions, setPositions] = useState<Record<string, Position>>(initial?.positions ?? {});
  const keyName = view + ":" + (view === "diagnostic" ? diagnosticIndex : selected);
  const position = positions[keyName] ?? {};
  const update = (patch: Position) => setPositions(old => ({...old, [keyName]: {...old[keyName], ...patch}}));
  const entry = cases[selected];
  const diagnostic = diagnostics[diagnosticIndex];
  const { rows, columns } = useWindowSize();
  const height = Math.max(1, (rows || 24) - 7);
  const width = Math.max(1, (columns || 80) - 2);
  const expected = useMemo(() => entry?.expected === undefined ? [] :
    outputLines(entry.expected, entry.comparison), [entry]);
  const actual = useMemo(() => entry ? outputLines(entry.stdout, entry.comparison) : [], [entry]);
  const differences = useMemo(() => {
    const result: number[] = [];
    for (let i = 0; i < Math.max(expected.length, actual.length); i++)
      if (expected[i] !== actual[i]) result.push(i);
    return result;
  }, [expected, actual]);
  const table = view === "sample" && entry?.expected !== undefined && ["PASS", "FAIL"].includes(entry.status);
  const raw = position.raw ?? !diagnostic?.explanation;
  const messages = useMemo(() => {
    if (view === "diagnostic" && diagnostic) {
      return [
        ...(diagnostic.title ? [...wrapText(diagnostic.title, width), ""] : []),
        ...(diagnostic.context?.length ? [
          ...diagnostic.context.map(c => (c.focus ? "› " : "  ") + String(c.line).padStart(4) + " │ " + c.text), ""
        ] : []),
        ...(diagnostic.explanation ? [...wrapText(diagnostic.explanation, width), "",
          (raw ? "▼ " : "▶ ") + "编译器原文" + (diagnostic.option ? " · " + diagnostic.option : "")] : []),
        ...(raw || !diagnostic.explanation ? diagnostic.raw.split(/\r?\n/) : [])
      ];
    }
    if (!entry) return ["无可用结果"];
    if (view === "log") return [
      outcome(entry) + " · " + entry.elapsedMs + " ms",
      "退出码：" + (entry.exitCode ?? "—") + " · 信号：" + (entry.signal ?? "—"),
      "", "stderr（不参与答案比较）：",
      ...(entry.stderr ? entry.stderr.split(/\r?\n/) : ["〈无〉"]),
      ...(!["PASS", "FAIL"].includes(entry.status) ? ["", "已产生的 stdout：",
        ...(entry.stdout ? entry.stdout.split(/\r?\n/) : ["〈无〉"])] : [])
    ];
    return [entry.expected === undefined ? "实际输出（无预期答案）：" : "已产生的实际输出：", ...entry.stdout.split(/\r?\n/)];
  }, [view, diagnostic, entry, raw, width]);
  const total = table ? Math.max(expected.length, actual.length) : messages.length;
  const maxTop = Math.max(0, total - height);
  const digits = Math.max(2, String(total).length);
  const left = Math.max(1, Math.floor((width - digits - 6) / 2));
  const right = Math.max(1, width - digits - 6 - left);
  const contentWidth = table ? Math.min(left, right) : width;
  const horizontalStep = Math.max(1, contentWidth - 2);
  const first = differences[0] ?? 0;
  const anchor = position.anchor ?? first;
  const initialTop = table ? Math.max(0, first - Math.min(2, height - 1)) : 0;
  const start = Math.min(position.top ?? initialTop, maxTop);
  const end = Math.min(start + height, total);
  const offsetFor = (index: number) => {
    const pair = rowParts(expected, actual, index);
    const col = Math.min(changeColumn(pair[0]), changeColumn(pair[1]));
    return Number.isFinite(col) ? Math.max(0, col - Math.floor(contentWidth / 2)) : 0;
  };
  const offset = position.offset ?? (table && differences.length ? offsetFor(first) : 0);
  useInput((char, key) => {
    if (key.escape || (key.ctrl && char === "c")) { onBack(); return; }
    if (!key.ctrl && !key.meta && char.toLowerCase() === "o" && entry && view !== "diagnostic" && onObserve) {
      onObserve(entry, { selected, diagnosticIndex, view, positions }); return;
    }
    if (key.tab && views.length) {
      setView(views[(views.indexOf(view) + views.length + (key.shift ? -1 : 1)) % views.length]);
      return;
    }
    if (char === "[" || char === "]") {
      const delta = char === "]" ? 1 : -1;
      if (view === "diagnostic")
        setDiagnosticIndex(i => Math.max(0, Math.min(diagnostics.length - 1, i + delta)));
      else setSelected(i => Math.max(0, Math.min(cases.length - 1, i + delta)));
      return;
    }
    if (key.return && view === "diagnostic" && diagnostic?.explanation) {
      update({raw: !raw, top: raw ? 0 : Math.max(0, messages.length - 1), offset: 0}); return;
    }
    if (table && ["n", "p"].includes(char.toLowerCase())) {
      const next = char.toLowerCase() === "n" ? differences.find(i => i > anchor) :
        [...differences].reverse().find(i => i < anchor);
      if (next !== undefined)
        update({anchor: next, top: Math.max(0, next - Math.min(2, height - 1)), offset: offsetFor(next)});
      return;
    }
    if (key.rightArrow) {
      for (let i = start; i < end; i++) {
        if (table ? stringWidth(outputCell(expected, i)) > offset + left ||
                    stringWidth(outputCell(actual, i)) > offset + right
                  : stringWidth(terminalText(messages[i])) > offset + width) {
          update({offset: offset + horizontalStep}); break;
        }
      }
    } else if (key.leftArrow) update({offset: Math.max(0, offset - horizontalStep)});
    else if (key.home || key.end) update({top: key.home ? 0 : maxTop});
    else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const step = key.pageUp || key.pageDown ? height : 1;
      const direction = key.upArrow || key.pageUp ? -1 : 1;
      update({top: Math.max(0, Math.min(maxTop, start + step * direction))});
    }
  });
  const subheading = view === "diagnostic" && diagnostic ?
    (diagnostic.severity === "error" ? "错误" : diagnostic.severity === "warning" ? "警告" : "信息") +
    " " + (diagnosticIndex + 1) + "/" + diagnostics.length + " · " + (diagnostic.location ?? "编译器") +
    (diagnostic.origin === "preset" ? " · 组件" : diagnostic.origin === "generated" ? " · 展开源码" : "") :
    entry ? entry.name + " · " + outcome(entry) + " · " + (selected + 1) + "/" + cases.length +
      (table ? " · " + differences.length + (entry.comparison === "tokens" ? " 项" : " 行") + "差异" : "") : "";
  const range = total ? "显示 " + (start + 1) + "–" + end + " / " + total : "";
  const observeHint = onObserve && entry && view !== "diagnostic" ? "O 观察当前源码 · " : "";
  const footer = observeHint + "Esc 返回 · Tab 视图 · [ ] 切换 · ↑↓←→ 滚动" +
    (table ? " · N/P 差异" : view === "diagnostic" && diagnostic?.explanation ? " · Enter 原文" : "");
  const numberTitle = entry?.comparison === "tokens" ? "序号" : "行号";
  const padCell = (text: string, cells: number) => text + " ".repeat(Math.max(0, cells - stringWidth(text)));
  const compact = width < 55;
  const tabLabels: Record<View, string> = {sample:"样例对比",diagnostic:"编译诊断",log:"运行日志"};
  const warningLabel = warningCount(diagnostics) ? (compact ? " · 警告 " + warningCount(diagnostics) : " · " + warningCount(diagnostics) + " 项警告") : "";
  const compileOk = report.kind === "samples" || (report.output.exitCode === 0 && !report.output.reason);
  const sampleOk = report.kind === "samples" && report.passed === report.total;
  return <Box flexDirection="column" paddingX={1} height={Math.max(1, rows || 24)}>
    <Text bold wrap="truncate-end">
      <Text color={compileOk ? "green" : "red"}>{compileOk ? "编译成功" : "编译失败"}</Text>
      {report.kind === "samples" ? <Text color={sampleOk ? "green" : "red"}>{(compact ? " · " : " · 本地样例 ") + report.passed + "/" + report.total + " 通过"}</Text> : null}
      <Text color="yellow">{warningLabel}</Text>
    </Text>
    <Text wrap="truncate-end">{compact ? "[" + tabLabels[view] + "] " + (views.indexOf(view)+1) + "/" + views.length + " · Tab 切换" :
      views.map(v => <Text key={v} color={v===view?"cyan":undefined} dimColor={v!==view} bold={v===view}>{v===view?"[":""}{tabLabels[v]}{v==="diagnostic"?" ("+diagnostics.length+")":""}{v===view?"]":""}  </Text>)}</Text>
    <Text dimColor wrap="truncate-end">{windowOf(terminalText(subheading), width)}</Text>
    <Text dimColor wrap="truncate-end">{"─".repeat(width)}</Text>
    {table ? <Text dimColor wrap="truncate-end">
      {padCell(numberTitle, digits + 2) + "  " +
        padCell(windowOf("样例输出", left), left) + "  " + windowOf("我的输出", right)}
    </Text> : null}
    <Box flexDirection="column" flexGrow={1} flexShrink={0}>
    {Array.from({ length: end - start }, (_, i) => {
      const line = start + i;
      if (!table) return <Text key={line} color={view==="diagnostic" && (messages[line].startsWith("› ") || line===0 && diagnostic?.title) ? (diagnostic?.severity==="error"?"red":"yellow") : undefined} wrap="truncate-end">{windowOf(terminalText(messages[line]), width, offset) || " "}</Text>;
      const changed = expected[line] !== actual[line];
      const number = String(line + 1).padStart(digits);
      const pair = rowParts(expected, actual, line);
      return <Text key={line} wrap="truncate-end">
        <Text color={changed ? "red" : undefined} dimColor={!changed}>{(changed ? "! " : "  ") + number}</Text>
        {"  "}{clippedParts(pair[0], left, offset).map((p,j) => <Text key={j} color={p.changed ? "red" : undefined}>{p.text}</Text>)}
        {"  "}{clippedParts(pair[1], right, offset).map((p,j) => <Text key={j} color={p.changed ? "red" : undefined}>{p.text}</Text>)}
      </Text>;
    })}
    </Box>
    <Text dimColor wrap="truncate-end">{windowOf(observationError ? "观察失败：" + terminalText(observationError) : range + (offset ? " · 横向 " + (offset + 1) : "") +
      (table && differences.length ? " · 差异 " + (differences.indexOf(anchor)+1) + "/" + differences.length : ""), width)}</Text>
    <Text dimColor wrap="truncate-end">{windowOf(compact ? observeHint + "Esc 返回 Tab 视图 [] ↑↓←→" + (table ? " N/P" : view==="diagnostic" && diagnostic?.explanation ? " Enter" : "") : footer, width)}</Text>
  </Box>;
}
