import { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import MarkdownIt from "markdown-it";
import stringWidth from "string-width";

type Span = { text: string; color?: string; bold?: boolean; dim?: boolean };
type Line = { spans: Span[]; code?: boolean };
type Section = { title: string; lines: Line[] };

const markdown = new MarkdownIt({ html: false });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const syntax = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b(?:bool|char|const|double|else|float|for|if|int|long|return|size_t|static|struct|typedef|unsigned|void|while|true|false)\b/g;
const safeText = (value: string) => value.replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "�");

function codeLines(text: string, language: string): Line[] {
  text = safeText(text.replace(/\n$/, ""));
  const lines: Line[] = [{ spans: [], code: true }];
  function append(text: string, style: Omit<Span, "text"> = {}) {
    text.split("\n").forEach((part, index) => {
      if (index) lines.push({ spans: [], code: true });
      if (part) lines[lines.length - 1].spans.push({ text: part, ...style });
    });
  }
  let end = 0;
  if (language === "c") for (const match of text.matchAll(syntax)) {
    const index = match.index!;
    append(text.slice(end, index));
    const value = match[0];
    append(value, value.startsWith("/") ? { dim: true } :
      { color: /^[\"']/.test(value) ? "yellow" : "cyan" });
    end = index + value.length;
  }
  append(text.slice(end));
  return lines;
}

function sectionsOf(source: string): Section[] {
  const sections: Section[] = [{ title: "使用约定", lines: [] }];
  let section = sections[0], heading = "", bullet = false;
  for (const token of markdown.parse(source, {})) {
    switch (token.type) {
      case "heading_open": heading = token.tag; break;
      case "heading_close": heading = ""; break;
      case "list_item_open": bullet = true; break;
      case "fence":
        section.lines.push(...codeLines(token.content, token.info.trim()), { spans: [] });
        break;
      case "inline": {
        if (heading === "h1") break;
        if (heading === "h2") {
          section = { title: safeText(token.content), lines: [] };
          sections.push(section);
          break;
        }
        const spans: Span[] = bullet ? [{ text: "• " }] : [];
        let bold = Boolean(heading);
        for (const part of token.children ?? []) {
          if (part.type === "strong_open") bold = true;
          else if (part.type === "strong_close") bold = false;
          else if (part.type === "softbreak" || part.type === "hardbreak") spans.push({ text: " " });
          else if (part.content) spans.push({ text: safeText(part.content),
            bold, color: part.type === "code_inline" ? "cyan" : undefined });
        }
        section.lines.push({ spans }, { spans: [] });
        bullet = false;
        break;
      }
    }
  }
  return sections.filter(section => section.lines.length);
}

function layout(line: Line, width: number, offset: number): Span[][] {
  const rows: Span[][] = [[]];
  let column = 0;
  for (const span of line.spans) {
    let chunk = "";
    for (const {segment} of graphemes.segment(span.text)) {
      const size = stringWidth(segment);
      if (line.code) {
        const left = column;
        column += size;
        if (column > offset + width) break;
        if (left < offset) continue;
      } else {
        if (column && column + size > width) {
          if (chunk) rows[rows.length - 1].push({ ...span, text: chunk });
          rows.push([]);
          chunk = "";
          column = 0;
        }
        column += size;
      }
      chunk += segment;
    }
    if (chunk) rows[rows.length - 1].push({ ...span, text: chunk });
  }
  return rows;
}

export function Manual({ markdown, version, onBack }: {
  markdown: string; version: string; onBack: () => void;
}) {
  const sections = useMemo(() => sectionsOf(markdown), [markdown]);
  const [cursor, setCursor] = useState(0);
  const [reading, setReading] = useState(false);
  const [positions, setPositions] = useState<Record<number, { top: number; left: number }>>({});
  const {columns, rows} = useWindowSize();
  const width = Math.max(8, (columns || 80) - 2), height = Math.max(1, (rows || 24) - 4);
  const section = sections[cursor];
  const {top, left} = positions[cursor] ?? {top: 0, left: 0};
  const body = useMemo(() => reading && section
    ? section.lines.flatMap(line => layout(line, width, left)) : [], [reading, section, width, left]);
  const codeWidth = useMemo(() => Math.max(0, ...(section?.lines.filter(line => line.code)
    .map(line => line.spans.reduce((sum, span) => sum + stringWidth(span.text), 0)) ?? [])), [section]);
  const maxTop = Math.max(0, body.length - height);
  const start = Math.min(top, maxTop);
  function move(next: number, offset: number) {
    setPositions(all => ({ ...all, [cursor]: {
      top: Math.max(0, Math.min(maxTop, next)),
      left: Math.max(0, Math.min(Math.max(0, codeWidth - width), offset))
    } }));
  }
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (reading) setReading(false);
      else onBack();
      return;
    }
    if (!reading) {
      if (key.return && section) setReading(true);
      if (sections.length && (key.upArrow || key.downArrow))
        setCursor((cursor + sections.length + (key.upArrow ? -1 : 1)) % sections.length);
      return;
    }
    if (key.leftArrow || key.rightArrow) move(start, left + (key.leftArrow ? -8 : 8));
    if (key.upArrow) move(start - 1, left);
    if (key.downArrow) move(start + 1, left);
    if (key.pageUp) move(start - height, left);
    if (key.pageDown) move(start + height, left);
  });
  const menuTop = Math.max(0, cursor - height + 1);
  return <Box flexDirection="column" paddingX={1}>
    <Text bold wrap="truncate-end">C99 函数速查 · {version}{reading ? " › " + section?.title : ""}</Text>
    {reading ? body.slice(start, start + height).map((line, i) =>
      <Text key={i} wrap="truncate-end">{line.length ? line.map((span, j) =>
        <Text key={j} bold={span.bold} color={span.color} dimColor={span.dim}>{span.text}</Text>) : " "}</Text>)
      : sections.slice(menuTop, menuTop + height).map((item, i) =>
        <Text key={i} wrap="truncate-end" color={i + menuTop === cursor ? "cyan" : undefined}>
          {i + menuTop === cursor ? "❯ " : "  "}{item.title}
        </Text>)}
    <Text dimColor wrap="truncate-end">{reading
      ? "Esc 目录 · ↑↓ / PgUp PgDn 翻页 · ←→ 长代码"
      : "Esc 返回 · ↑↓ 选择 · Enter 阅读"}</Text>
  </Box>;
}
