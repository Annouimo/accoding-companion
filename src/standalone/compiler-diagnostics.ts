import type { ProcessResult } from "../judge/process";

export interface CompilerDiagnostic {
  severity: "error" | "warning" | "info";
  location?: string;
  message: string;
  explanation?: string;
  title?: string;
  option?: string;
  origin?: "user" | "preset" | "generated";
  context?: { line: number; text: string; focus: boolean }[];
  raw: string;
}

const explanations: Record<string, string> = {
  "-Wunused-variable": "变量定义后未被使用。检查是否遗漏操作，或误用了其他变量。",
  "-Wunused-but-set-variable": "变量被赋值，但其值从未被读取。检查是否遗漏使用。",
  "-Wuninitialized": "变量可能在初始化前被使用。检查所有执行路径。",
  "-Wmaybe-uninitialized": "变量可能在初始化前被使用。检查所有执行路径。",
  "-Wshadow": "新声明遮蔽了外层同名变量。检查是否意外重复定义。",
  "-Wformat": "检查输入输出的格式符、参数数量和类型是否一致。",
  "-Wformat-security": "检查格式字符串的来源及对应参数。",
  "-Wparentheses": "检查表达式中的运算符、括号及优先级。",
  "-Warray-bounds": "检查数组的容量及下标范围。",
  "-Wreturn-type": "检查函数返回类型及所有分支是否正确返回。",
  "-Wimplicit-function-declaration": "检查函数声明、拼写和所需头文件。",
};

const titles: Record<string, string> = {
  "-Wunused-variable": "未使用的变量",
  "-Wunused-but-set-variable": "赋值后未使用的变量",
  "-Wuninitialized": "未初始化的变量",
  "-Wmaybe-uninitialized": "可能未初始化的变量",
  "-Wshadow": "变量遮蔽",
  "-Wformat": "输入输出格式问题",
  "-Wformat-security": "格式字符串问题",
  "-Wparentheses": "可疑的表达式",
  "-Warray-bounds": "可能的数组越界",
  "-Wreturn-type": "函数返回值问题",
  "-Wimplicit-function-declaration": "函数未声明",
};

function warningOption(message: string) {
  const option = /\[(-W[\w-]+)(?:=[^\]]*)?\]\s*$/.exec(message)?.[1];
  return option;
}

/** Keep related notes, source excerpts and unknown output, even if parsing fails. */
export function parseCompilerDiagnostics(result: ProcessResult): CompilerDiagnostic[] {
  const raw = [result.stderr, result.stdout].filter(Boolean).join("\n").trimEnd();
  const diagnostics: CompilerDiagnostic[] = [];
  let prefix: string[] = [];
  for (const line of raw ? raw.split(/\r?\n/) : []) {
    const match = /^(.*?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    const generic = match ? null : /^(.*?):\s*(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    const bare = match || generic ? null : /^(fatal error|error|warning|note):\s*(.*)$/.exec(line);
    const kind = match?.[4] ?? generic?.[2] ?? bare?.[1];
    const message = match?.[5] ?? generic?.[3] ?? bare?.[2];
    if (kind && kind !== "note" && message !== undefined) {
      const location = match ? match[1] + ":" + match[2] + (match[3] ? ":" + match[3] : "") : generic?.[1];
      diagnostics.push({
        severity: kind === "warning" ? "warning" : "error", location, message,
        option: warningOption(message), title: titles[warningOption(message) ?? ""],
        explanation: explanations[warningOption(message) ?? ""], raw: [...prefix, line].join("\n")
      });
      prefix = [];
    } else if (diagnostics.length) {
      diagnostics[diagnostics.length - 1].raw += "\n" + line;
    } else prefix.push(line);
  }
  if (prefix.length || (!diagnostics.length && (result.exitCode !== 0 || result.reason))) {
    const message = prefix.join("\n") || (result.reason === "TIMEOUT" ? "编译超时" : "编译器退出，未提供诊断。");
    diagnostics.push({ severity: result.exitCode !== 0 || result.reason ? "error" : "info", message: message.split("\n")[0], raw: message });
  }
  return diagnostics;
}

export function warningCount(diagnostics?: CompilerDiagnostic[]) {
  return diagnostics?.filter(item => item.severity === "warning").length ?? 0;
}

/** Only use the mapped diagnostics when the formal build produced the same primary messages.
 * The formal compilation remains authoritative; differences (e.g. __LINE__) must not be hidden.
 */
export function preferMappedDiagnostics(formal: ProcessResult, mapped: ProcessResult): CompilerDiagnostic[] {
  const a = parseCompilerDiagnostics(formal), b = parseCompilerDiagnostics(mapped);
  if (formal.exitCode === mapped.exitCode && formal.reason === mapped.reason &&
      !mapped.reason && a.length === b.length && a.every((item, i) => item.severity === b[i].severity && item.message === b[i].message))
    return b;
  return a;
}

export function diagnosticText(diagnostics: CompilerDiagnostic[]) {
  return diagnostics.map(d => [d.raw, d.explanation].filter(Boolean).join("\n")).join("\n\n");
}

/** Attach context from the immutable compilation input, not a later disk read. */
export function attachDiagnosticContext(
  diagnostics: CompilerDiagnostic[], source: string, sourceName: string, mapped: boolean
): CompilerDiagnostic[] {
  const requested = new Map<string, Set<number>>();
  const locations = diagnostics.map(d => {
    const match = /^(.*?):(\d+)(?::\d+)?$/.exec(d.location ?? "");
    if (!match) return undefined;
    const file = match[1].replace(/\\/g, "/"), line = Number(match[2]);
    // The ordinary compilation input is named submit.c or submit.cpp.
    const key = mapped ? file : /(?:^|\/)submit\.(?:c|cpp)$/.test(file) ? "<generated>" : "";
    if (!key || (mapped && key !== sourceName && !key.startsWith("preset/"))) return undefined;
    const numbers = requested.get(key) ?? new Set<number>();
    for (let i = Math.max(1, line - 2); i <= line + 2; i++) numbers.add(i);
    requested.set(key, numbers);
    return {key, line};
  });
  if (!requested.size) return diagnostics;
  const found = new Map<string, Map<number,string>>();
  let file = mapped ? sourceName : "<generated>", line = 1;
  for (const text of source.split(/\r?\n/)) {
    const directive = mapped ? /^#line (\d+) ("(?:[^"\\]|\\.)*")\s*$/.exec(text) : null;
    if (directive) {
      try { file = JSON.parse(directive[2]); line = Number(directive[1]); continue; }
      catch { /* not one of our generated directives */ }
    }
    if (requested.get(file)?.has(line)) {
      const rows = found.get(file) ?? new Map<number,string>();
      rows.set(line, text); found.set(file, rows);
    }
    line++;
  }
  return diagnostics.map((d,i) => {
    const loc = locations[i];
    if (!loc) return d;
    const rows = found.get(loc.key);
    return {...d, origin: loc.key === "<generated>" ? "generated" :
      loc.key.startsWith("preset/") ? "preset" : "user",
      context: rows?.has(loc.line) ? [...rows].filter(([n]) => Math.abs(n-loc.line)<=2)
        .map(([line,text])=>({line,text,focus:line===loc.line})) : undefined};
  });
}
