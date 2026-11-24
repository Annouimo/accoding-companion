import { useMemo, useState } from "react";
import { copyExample } from "./clipboard";
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
        if (column > offset + width) continue;
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

export type Variant = { key: string; label: string; symbols: string[]; signatures: string[]; note: string; example: string; advancedSignatures?: string[] };
type Entry = { id: string; title: string; signatures: string[]; description: string; example: string;
  keywords?: string[]; commonSignatures?: string[]; advancedSignatures?: string[]; related?: string[]; variants?: Variant[] };
type Category = { title: string; entries: Entry[] };
type SectionNode = { title: string; children?: SectionNode[]; entries?: string[] };
export type Reference = { categories: Category[]; sections: SectionNode[]; notes: string };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(x => typeof x === "string");
export function parseReference(raw: string): Reference {
  const data = JSON.parse(raw);
  if (data?.schemaVersion !== 1 || !Array.isArray(data.categories) ||
    !data.categories.every((category: Category) => typeof category?.title === "string" &&
      Array.isArray(category.entries) && category.entries.length > 0 &&
      category.entries.every(item => [item?.id, item?.title, item?.description, item?.example]
        .every(value => typeof value === "string") && strings(item.signatures) &&
        (item.keywords === undefined || strings(item.keywords)) &&
        (item.commonSignatures === undefined || strings(item.commonSignatures)) &&
        (item.advancedSignatures === undefined || strings(item.advancedSignatures)) &&
        (item.related === undefined || strings(item.related)) &&
        (item.variants === undefined || (Array.isArray(item.variants) && item.variants.length > 0 &&
          item.variants.every(v => [v?.key, v?.label, v?.note, v?.example].every(x => typeof x === "string") &&
            strings(v.symbols) && strings(v.signatures) &&
            (v.advancedSignatures === undefined || strings(v.advancedSignatures))) &&
          new Set(item.variants.map(v=>v.key)).size === item.variants.length)))))
    throw new Error("无法读取此版本的函数速查数据。");
  const categories: Category[] = data.categories;
  const entries = categories.flatMap(c => c.entries);
  const ids = new Set(entries.map(e => e.id));
  if (ids.size !== entries.length) throw new Error("函数速查条目 ID 重复。");
  if (entries.some(e=>e.related?.some(id=>id===e.id || !ids.has(id)))) throw new Error("相关条目引用无效。");
  function valid(nodes: unknown, depth = 0): nodes is SectionNode[] {
    return depth <= 8 && Array.isArray(nodes) && nodes.length > 0 && nodes.every(n =>
      n && typeof n.title === "string" &&
      (n.children !== undefined ? n.entries === undefined && valid(n.children, depth+1) :
        strings(n.entries) && n.entries.length > 0 && n.entries.every((id: string)=>ids.has(id))));
  }
  const sections = data.sections ?? categories.map(c => ({title:c.title, entries:c.entries.map(e=>e.id)}));
  if (!valid(sections)) throw new Error("函数速查目录无效。");
  return { categories, sections, notes: typeof data.notes === "string" ? data.notes : "" };
}

export type ReferenceView = { path: number[]; cursor: number; id?: string; top: number; left: number;
  type?: string; selectedType?: string; searching: boolean; query: string; searchCursor: number; notes: boolean; trail?: {id: string; selectedType?: string; top: number; left: number}[] };
export const initialReferenceView = (): ReferenceView =>
  ({path:[],cursor:0,top:0,left:0,searching:false,query:"",searchCursor:0,notes:false});

export function searchReference(reference: Reference, query: string): { entry: Entry; category: string; variant?: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return reference.categories.flatMap(c => c.entries.flatMap(entry => {
    const variant = entry.variants?.find(v=>v.symbols.some(s=>s.toLowerCase()===q)) ??
      entry.variants?.find(v=>v.symbols.some(s=>s.toLowerCase().includes(q)));
    const exact = variant?.symbols.some(s=>s.toLowerCase()===q) || entry.id.toLowerCase()===q;
    const hay = [entry.id,entry.title,entry.description,c.title,...entry.signatures,...(entry.keywords??[])].join(" ").toLowerCase();
    return q.split(/\s+/).every(term=>hay.includes(term)) ? [{entry,category:c.title,variant:variant?.key,
      score: exact?0:variant?1:entry.title.includes(q)?2:3}] : [];
  })).sort((a,b)=>a.score-b.score || a.entry.title.localeCompare(b.entry.title,"zh"));
}

export function ReferenceManual({ reference, version, initial, save, onBack }: {
  reference: Reference; version: string; initial: ReferenceView; save: (view: ReferenceView)=>void; onBack: ()=>void;
}) {
  const [view,setView] = useState(initial);
  const [status,setStatus] = useState("");
  const [relatedCursor,setRelatedCursor] = useState<number>();
  const {columns,rows} = useWindowSize();
  const width = Math.max(8,(columns||80)-2), height = Math.max(1,(rows||24)-6);
  const all = useMemo(()=>new Map(reference.categories.flatMap(c=>c.entries.map(e=>[e.id,e] as const))),[reference]);
  const item = view.id ? all.get(view.id) : undefined;
  const variant = item?.variants?.find(v=>v.key===view.selectedType) ??
    item?.variants?.find(v=>v.key===view.type) ?? item?.variants?.[0];
  const example = variant?.example ?? item?.example ?? "";
  const related = (item?.related ?? []).map(id=>all.get(id)!).filter(Boolean);
  let nodes = reference.sections;
  let leaf: SectionNode | undefined;
  const crumbs: string[] = [];
  for (const index of view.path) {
    const node: SectionNode | undefined = nodes[index];
    if (!node) break;
    crumbs.push(node.title);
    leaf = node;
    nodes = node.children ?? [];
  }
  function entryCrumbs(nodes: SectionNode[], id: string): string[] | undefined {
    for (const n of nodes) {
      if(n.entries?.includes(id)) return [n.title];
      const sub=n.children&&entryCrumbs(n.children,id);
      if(sub) return [n.title,...sub];
    }
  }
  const detailCrumbs = item ? (entryCrumbs(reference.sections,item.id) ?? crumbs) : crumbs;
  const results = useMemo(()=>searchReference(reference,view.query),[reference,view.query]);
  const choices = view.searching ? results.map(r=>({title:r.entry.title,id:r.entry.id,summary:r.category+" · "+(r.entry.description.split("\n")[0]??""),variant:r.variant})) :
    leaf?.entries ? leaf.entries.map(id=>({title:all.get(id)!.title,id,summary:all.get(id)!.description.split("\n")[0]??"",variant:undefined})) :
    nodes.map(n=>({title:n.title,id:undefined,summary:"",variant:undefined}));
  const cursor = view.searching ? view.searchCursor : view.cursor;
  const reading = Boolean(item || view.notes);
  const lines = useMemo(()=>{
    if(view.notes) return sectionsOf(reference.notes || "此资源版本没有独立使用约定。").flatMap(s=>s.lines);
    if(!item) return [];
    const signatures = variant ? [...(item.commonSignatures??[]),...variant.signatures] : item.signatures;
    const advanced = [...(item.advancedSignatures??[]),...(variant?.advancedSignatures??[])];
    const normal = signatures.filter(s=>!advanced.includes(s));
    const prose = (text:string)=>sectionsOf(text).flatMap(s=>s.lines);
    const result: Line[] = [{spans:[{text:"接口",bold:true,dim:true}]},...codeLines(normal.join("\n"),"c"),{spans:[]}];
    if(item.description) result.push(...prose(item.description));
    if(variant?.note) result.push(...prose(variant.note));
    if(example) result.push({spans:[{text:"示例 · C 复制代码",bold:true,dim:true}]},...codeLines(example,"c"));
    if(advanced.length) result.push({spans:[]},{spans:[{text:"扩展接口 · 显式容量",bold:true,dim:true}]},...codeLines(advanced.join("\n"),"c"));
    if(related.length) result.push({spans:[]},{spans:[{text:"相关操作 · R 打开",bold:true,dim:true}]},...prose(related.map(e=>e.title).join(" · ")));
    return result;
  },[item,variant,example,view.notes,reference.notes,all]);
  const body = useMemo(()=>lines.flatMap(l=>layout(l,width,view.left)),[lines,width,view.left]);
  const maxTop = Math.max(0,body.length-height), top=Math.min(view.top,maxTop);
  const maxLeft = Math.max(0,...lines.filter(l=>l.code).map(l=>l.spans.reduce((n,s)=>n+stringWidth(s.text),0)))-width;
  function patch(change:Partial<ReferenceView>) {setView(old=>({...old,...change}));setStatus("");}
  function back() {
    if(relatedCursor!==undefined) {setRelatedCursor(undefined);return;}
    if(reading&&view.trail?.length) patch({...view.trail[view.trail.length-1],trail:view.trail.slice(0,-1)});
    else if(reading) patch({id:undefined,notes:false,top:0,left:0,trail:undefined});
    else if(view.searching) patch({searching:false,query:"",searchCursor:0});
    else if(view.path.length) patch({path:view.path.slice(0,-1),cursor:view.path[view.path.length-1]});
    else {save(view);onBack();}
  }
  function select() {
    const choice=choices[cursor];
    if(!choice) return;
    if(choice.id) patch({id:choice.id,selectedType:choice.variant,top:0,left:0,trail:undefined});
    else patch({path:[...view.path,cursor],cursor:0});
  }
  useInput((input,key)=>{
    if(key.escape || (key.ctrl&&input==="c")) {back();return;}
    if(relatedCursor!==undefined) {
      if(key.upArrow||key.downArrow) setRelatedCursor((relatedCursor+related.length+(key.upArrow?-1:1))%related.length);
      else if(key.return&&item&&related[relatedCursor]) {
        patch({id:related[relatedCursor].id,selectedType:undefined,top:0,left:0,trail:[...(view.trail??[]),{id:item.id,selectedType:view.selectedType,top:view.top,left:view.left}]});
        setRelatedCursor(undefined);
      }
      return;
    }
    if(!reading&&view.searching) {
      if(key.return) select();
      else if(key.upArrow||key.downArrow||key.pageUp||key.pageDown) patch({searchCursor:Math.max(0,Math.min(choices.length-1,cursor+(key.upArrow?-1:key.downArrow?1:key.pageUp?-height:height)))});
      else if(key.backspace||key.delete) patch({query:Array.from(view.query).slice(0,-1).join(""),searchCursor:0});
      else if(!key.ctrl&&!key.meta&&input) patch({query:view.query+safeText(input).replace(/[\r\n]/g,""),searchCursor:0});
      return;
    }
    if(input.toLowerCase()==="h"&&!key.ctrl&&!key.meta) {save(view);onBack();return;}
    if(input==="/"&&!key.ctrl) {patch({searching:true,query:"",searchCursor:0,id:undefined,notes:false,top:0,left:0,trail:undefined});return;}
    if(input.toLowerCase()==="g"&&!key.ctrl) {patch({...initialReferenceView(),type:view.type});return;}
    if(!reading) {
      if(input.toLowerCase()==="u"&&!key.ctrl) {patch({notes:true,top:0,left:0});return;}
      if(key.return) select();
      else if(choices.length&&(key.upArrow||key.downArrow||key.pageUp||key.pageDown))
        patch({cursor:Math.max(0,Math.min(choices.length-1,cursor+(key.upArrow?-1:key.downArrow?1:key.pageUp?-height:height)))});
      return;
    }
    if(input.toLowerCase()==="r"&&!key.ctrl&&related.length) {setRelatedCursor(0);return;}
    if(key.tab&&item?.variants?.length&&variant) {
      const index=item.variants.indexOf(variant);
      const next=item.variants[(index+item.variants.length+(key.shift?-1:1))%item.variants.length];
      patch({type:next.key,selectedType:next.key,top:0,left:0});
    } else if(input.toLowerCase()==="c"&&!key.ctrl&&example) {
      void copyExample(example).then(()=>setStatus("已复制完整示例"),e=>setStatus("复制失败："+String(e instanceof Error?e.message:e)));
    } else if(key.leftArrow||key.rightArrow) patch({left:Math.max(0,Math.min(maxLeft,view.left+(key.leftArrow?-8:8)))});
    else if(key.upArrow||key.downArrow||key.pageUp||key.pageDown) patch({top:Math.max(0,Math.min(maxTop,top+(key.upArrow?-1:key.downArrow?1:key.pageUp?-height:height)))});
  });
  const menuHeight = Math.max(1,height-(view.searching?1:0));
  const menuTop = Math.max(0,Math.min(cursor,choices.length-1)-menuHeight+1);
  return <Box flexDirection="column" paddingX={1}>
    <Text bold wrap="truncate-end">C 函数速查 · {version}{detailCrumbs.length?" › "+detailCrumbs.join(" › "):""}{item?" › "+item.title:view.notes?" › 使用约定":""}</Text>
    {relatedCursor!==undefined ? <>
      <Text bold>相关操作</Text>
      {related.map((e,i)=><Text key={e.id} color={relatedCursor===i?"cyan":undefined}>{relatedCursor===i?"❯ ":"  "}{safeText(e.title)}</Text>)}
    </> : reading ? <>
      {item?.variants?.length ? <Text wrap="truncate-end">{item.variants.map(v=><Text key={v.key} bold={v===variant} color={v===variant?"cyan":undefined}>{v===variant?"["+v.label+"]":v.label}  </Text>)}<Text dimColor>Tab 切换类型</Text></Text>:null}
      {body.slice(top,top+height).map((line,i)=><Text key={i} wrap="truncate-end">{line.length?line.map((span,j)=><Text key={j} bold={span.bold} color={span.color} dimColor={span.dim}>{span.text}</Text>):" "}</Text>)}
      <Text dimColor wrap="truncate-end">{status||("行 "+(body.length?top+1:0)+"–"+Math.min(top+height,body.length)+" / "+body.length)}</Text>
    </> : <>
      {view.searching?<Text color="cyan" wrap="truncate-end">搜索：{view.query}▏ · {results.length} 项</Text>:null}
      {choices.slice(menuTop,menuTop+menuHeight).map((choice,i)=><Text key={i} wrap="truncate-end" color={i+menuTop===cursor?"cyan":undefined}>{i+menuTop===cursor?"❯ ":"  "}{safeText(choice.title)}{choice.summary?<Text dimColor> · {safeText(choice.summary)}</Text>:null}</Text>)}
      {!choices.length?<Text dimColor>{view.searching?"输入函数名或中文用途开始搜索":"没有条目"}</Text>:null}
    </>}
    <Text dimColor wrap="truncate-end">{relatedCursor!==undefined?"Esc 取消 · ↑↓ 选择 · Enter 打开":reading?"Esc 返回 · H 关闭 · / 搜索 · ↑↓ 翻页"+(example?" · C 复制":"")+(related.length?" · R 相关":""):
      view.searching?"Esc 取消 · ↑↓ 选择 · Enter 打开":"Esc 返回 · H 关闭 · G 首页 · / 搜索 · U 使用约定 · Enter 打开"}</Text>
  </Box>;
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
