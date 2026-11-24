import { useMemo, useState } from "react";
import { Box, Text, useInput, useWindowSize } from "ink";
import MarkdownIt from "markdown-it";
import stringWidth from "string-width";

type Span = { text: string; color?: string; bold?: boolean; dim?: boolean };
type Line = { spans: Span[]; code?: boolean };
type Section = { title: string; lines: Line[] };

const markdown = new MarkdownIt({ html: false });
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const syntax = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|(?:\d|\.\d)(?:[eEpP][+-]|[\w.])*|[A-Za-z_]\w*/g;
const keywords = new Set(("auto bool char const double enum extern float int long register restrict short " +
  "signed size_t static struct typedef union unsigned void volatile _Bool _Complex _Imaginary " +
  "break case continue default do else for goto if inline return sizeof switch while").split(" "));
const constants = new Set(["true", "false", "NULL", "EOF"]);

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
    if (value.startsWith("//") || value.startsWith("/*")) append(value, { dim: true });
    else if (keywords.has(value)) append(value, { color: "cyan" });
    else if (constants.has(value) || /^(?:["']|\d|\.\d)/.test(value)) append(value, { color: "yellow" });
    else if (/^\s*\(/.test(text.slice(index + value.length))) append(value, { color: "green", bold: true });
    else append(value);
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

type Entry = { id: string; title: string; signatures: string[]; description: string; example: string };
type Category = { title: string; entries: Entry[] };

export function parseReference(raw: string): Category[] {
  const data = JSON.parse(raw);
  if (data?.schemaVersion !== 1 || !Array.isArray(data.categories) ||
    !data.categories.every((category: Category) => typeof category?.title === "string" &&
      Array.isArray(category.entries) && category.entries.length > 0 &&
      category.entries.every(item => [item?.id, item?.title, item?.description, item?.example]
        .every(value => typeof value === "string") && Array.isArray(item.signatures) &&
        item.signatures.every(value => typeof value === "string"))))
    throw new Error("无法读取此版本的函数速查数据。");
  return data.categories;
}

export function Manual({ markdown, reference, version, onBack }: {
  markdown: string; reference?: Category[]; version: string; onBack: () => void;
}) {
  const sections = useMemo(() => sectionsOf(markdown), [markdown]);
  const [category, setCategory] = useState(0);
  const [entry, setEntry] = useState(0);
  const [level, setLevel] = useState(0);
  const [top, setTop] = useState(0);
  const [left, setLeft] = useState(0);
  const { columns, rows } = useWindowSize();
  const width = Math.max(8, (columns || 80) - 2), height = Math.max(1, (rows || 24) - 4);
  const group = reference?.[category];
  const item = group?.entries[entry];
  const reading = reference ? level === 2 : level === 1;
  const lines = useMemo(() => {
    if (!reading) return [];
    if (!item) return sections[category]?.lines ?? [];
    const text = sectionsOf(item.description).flatMap(section => section.lines);
    return [...codeLines(item.signatures.join("\n"), "c"), { spans: [] },
      ...text, ...(item.example ? codeLines(item.example, "c") : [])];
  }, [reading, item, sections, category]);
  const body = useMemo(() => lines.flatMap(line => layout(line, width, left)), [lines, width, left]);
  const maxTop = Math.max(0, body.length - height);
  const start = Math.min(top, maxTop);
  const codeWidth = Math.max(0, ...lines.filter(line => line.code)
    .map(line => line.spans.reduce((sum, span) => sum + stringWidth(span.text), 0)));
  const choices = (level === 1 ? group?.entries : reference ?? sections) ?? [];
  const cursor = level === 1 ? entry : category;
  const title = reference ? group?.title : sections[category]?.title;
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      if (level === 0) onBack();
      else setLevel(level - 1);
      return;
    }
    if (!reading) {
      if (key.return && choices.length) {
        setTop(0); setLeft(0); setLevel(level + 1);
      } else if (choices.length && (key.upArrow || key.downArrow)) {
        const next = (cursor + choices.length + (key.upArrow ? -1 : 1)) % choices.length;
        if (level === 1) setEntry(next);
        else { setCategory(next); setEntry(0); }
      }
      return;
    }
    if (key.leftArrow || key.rightArrow)
      setLeft(Math.max(0, Math.min(Math.max(0, codeWidth - width), left + (key.leftArrow ? -8 : 8))));
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.upArrow ? -1 : key.downArrow ? 1 : key.pageUp ? -height : height;
      setTop(Math.max(0, Math.min(maxTop, start + delta)));
    }
  });
  const menuTop = Math.max(0, cursor - height + 1);
  return <Box flexDirection="column" paddingX={1}>
    <Text bold wrap="truncate-end">C 函数速查 · {version}{level > 0 ? " › " + title : ""}{item && reading ? " › " + item.title : ""}</Text>
    {reading ? body.slice(start, start + height).map((line, i) =>
      <Text key={i} wrap="truncate-end">{line.length ? line.map((span, j) =>
        <Text key={j} bold={span.bold} color={span.color} dimColor={span.dim}>{span.text}</Text>) : " "}</Text>)
      : choices.slice(menuTop, menuTop + height).map((choice, i) =>
        <Text key={i} wrap="truncate-end" color={i + menuTop === cursor ? "cyan" : undefined}>
          {i + menuTop === cursor ? "❯ " : "  "}{safeText(choice.title)}
        </Text>)}
    <Text dimColor wrap="truncate-end">{reading
      ? "Esc 返回 · ↑↓ / PgUp PgDn 翻页 · ←→ 长代码"
      : "Esc 返回 · ↑↓ 选择 · Enter 打开"}</Text>
  </Box>;
}
