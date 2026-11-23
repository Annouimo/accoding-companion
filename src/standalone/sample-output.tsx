import React, { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import stringWidth from "string-width";
import { normalizeOutput } from "../judge/judge";
import type { Comparison } from "../model";
import type { SampleCaseReport, SampleTestReport } from "./workflow";

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

export function SampleOutput({ report, onBack }: { report: SampleTestReport; onBack: () => void }) {
  const cases = report.kind === "samples" ? report.cases : [];
  const firstFailure = cases.findIndex(entry => entry.status !== "PASS");
  const [selected, setSelected] = useState(Math.max(0, firstFailure));
  const entry = cases[selected];
  const table = entry?.expected !== undefined && ["FAIL", "PASS"].includes(entry.status);
  const expected = useMemo(() => entry?.expected === undefined ? [] :
    outputLines(entry.expected, entry.comparison), [entry]);
  const actual = useMemo(() => entry ? outputLines(entry.stdout, entry.comparison) : [], [entry]);
  const difference = useMemo(() => {
    const total = Math.max(expected.length, actual.length);
    for (let index = 0; index < total; index++) {
      if (expected[index] !== actual[index]) return index;
    }
    return -1;
  }, [expected, actual]);

  const diagnostic = report.kind === "compile" ? report.output.stderr || report.output.stdout ||
    (report.output.reason === "TIMEOUT" ? "编译超时" : "编译器退出，未提供诊断。")
    : entry?.stderr || (entry?.status === "UNCHECKED" ? entry.stdout : "");
  const messages = useMemo(() => diagnostic ? diagnostic.trimEnd().split(/\r?\n/) : [], [diagnostic]);
  const { rows, columns } = useWindowSize();
  const height = Math.max(1, (rows || 24) - 5);
  const width = Math.max(1, (columns || 80) - 2);
  const total = table ? Math.max(expected.length, actual.length) : messages.length;
  const maxTop = Math.max(0, total - height);
  const [top, setTop] = useState<number>();
  const [offset, setOffset] = useState(0);
  const initial = table ? Math.max(0, difference - Math.min(2, height - 1)) : 0;
  const start = Math.min(top ?? initial, maxTop);
  const end = Math.min(start + height, total);
  const digits = Math.max(2, String(total).length);
  const left = Math.max(1, Math.floor((width - digits - 6) / 2));
  const right = Math.max(1, width - digits - 6 - left);
  const contentWidth = table ? Math.min(left, right) : width;
  const horizontalStep = Math.max(1, contentWidth - 2);

  useInput((char, key) => {
    if (key.escape || (key.ctrl && char === "c")) { onBack(); return; }
    if (char === "[" || char === "]") {
      const next = Math.min(cases.length - 1, Math.max(0, selected + (char === "]" ? 1 : -1)));
      if (next >= 0 && next !== selected) {
        setSelected(next);
        setTop(undefined);
        setOffset(0);
      }
      return;
    }
    if (key.rightArrow) {
      const hasMore = (s: string, w: number) => stringWidth(s) > offset + w;
      for (let index = start; index < end; index++) {
        if (table ? (index < expected.length && hasMore(outputCell(expected, index), left)) ||
                    (index < actual.length && hasMore(outputCell(actual, index), right))
                  : hasMore(terminalText(messages[index]), width)) {
          setOffset(offset + horizontalStep);
          break;
        }
      }
    } else if (key.leftArrow) setOffset(Math.max(0, offset - horizontalStep));
    else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const step = key.pageUp || key.pageDown ? height : 1;
      const direction = key.upArrow || key.pageUp ? -1 : 1;
      setTop(Math.max(0, Math.min(maxTop, start + step * direction)));
    }
  });

  const heading = report.kind === "compile" ? "编译失败" : entry
    ? entry.name + " · " + outcome(entry) + " · " + (selected + 1) + "/" + cases.length +
      (table ? " · 预期 " + expected.length + (entry.comparison === "tokens" ? " 项" : " 行") +
        "，实际 " + actual.length + (entry.comparison === "tokens" ? " 项" : " 行") : "")
    : "样例未运行";
  const range = total ? "显示 " + (start + 1) + "–" + end + " / " + total : "";
  const footer = "Esc 返回 · ↑↓ 滚动 · ←→ 长行" + (cases.length > 1 ? " · [ ] 样例" : "") +
    (range ? " · " + range : "");
  const numberTitle = entry?.comparison === "tokens" ? "序号" : "行号";
  const padCell = (text: string, cells: number) => text + " ".repeat(Math.max(0, cells - stringWidth(text)));

  return <Box flexDirection="column" paddingX={1}>
    <Text bold color={entry?.status === "PASS" ? "green" : entry?.status === "UNCHECKED" ? undefined : "red"}
      wrap="truncate-end">{windowOf(terminalText(heading), width)}</Text>
    {table ? <Text dimColor wrap="truncate-end">
      {padCell(numberTitle, digits + 2) + "  " +
        padCell(windowOf("样例输出", left), left) + "  " + windowOf("我的输出", right)}
    </Text> : null}
    {Array.from({ length: end - start }, (_, i) => {
      const line = start + i;
      if (!table) return <Text key={line} wrap="truncate-end">{windowOf(terminalText(messages[line]), width, offset) || " "}</Text>;
      const changed = expected[line] !== actual[line];
      const number = String(line + 1).padStart(digits);
      const sample = windowOf(outputCell(expected, line), left, expected[line] ? offset : 0);
      const output = windowOf(outputCell(actual, line), right, actual[line] ? offset : 0);
      return <Text key={line} wrap="truncate-end">
        <Text color={changed ? "red" : undefined} dimColor={!changed}>{(changed ? "! " : "  ") + number}</Text>
        {"  " + padCell(sample, left) + "  "}
        <Text color={changed ? "red" : undefined}>{output}</Text>
      </Text>;
    })}
    <Text dimColor wrap="truncate-end">{windowOf(footer, width)}</Text>
  </Box>;
}
