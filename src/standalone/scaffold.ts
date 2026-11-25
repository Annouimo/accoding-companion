import { languages } from "../workspace/sources";
import fs from "node:fs/promises";
import path from "node:path";

export interface ComponentSpec {
  id: string;
  description?: string;
  symbols: string[];
  source?: string;
  code?: string;
  requires: string[];
}

export interface PresetManifest {
  schemaVersion: 1 | 2;
  languageId?: string;
  id: string;
  language: "c";
  standard: "c99";
  headerFile: string;
  systemHeaders: string[];
  components: ComponentSpec[];
}

export interface LoadedPreset {
  manifest: PresetManifest;
  code: Map<string, string>;
  order: string[];
  manual?: string;
  reference?: string;
}

export const PRESET_REFERENCE = "reference.json";

export const PRESET_MANUAL = "manual.zh-CN.md";

const IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;
const HEADER = /^[A-Za-z_][A-Za-z_0-9.-]*\.h$/;
const SYSTEM_HEADER = /^[A-Za-z0-9_./+-]+\.h$/;

function fail(message: string): never {
  throw new Error("Scaffold preset: " + message);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    fail(label + " must be an array of strings");
  return value as string[];
}

export async function loadPreset(manifestPath: string): Promise<LoadedPreset> {
  const requested = await fs.realpath(manifestPath);
  const absolute = (await fs.stat(requested)).isDirectory()
    ? path.join(requested, "manifest.json") : requested;
  const base = path.dirname(absolute);
  const raw: unknown = JSON.parse(await fs.readFile(absolute, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid JSON object");
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== 1 && data.schemaVersion !== 2) fail("unsupported schemaVersion");
  if (typeof data.id !== "string" || !IDENTIFIER.test(data.id.replace(/-/g, "_")))
    fail("invalid preset id");
  if (data.language !== "c" || data.standard !== "c99")
    fail("only C presets are implemented by this assembler");
  if (data.schemaVersion === 2 && data.languageId !== languages.c.id)
    fail("invalid languageId for C preset");
  if (typeof data.headerFile !== "string" || !HEADER.test(data.headerFile))
    fail("headerFile must be a local .h filename");
  const systemHeaders = stringArray(data.systemHeaders, "systemHeaders");
  if (!systemHeaders.every((name) => SYSTEM_HEADER.test(name) && !name.includes("..")))
    fail("invalid system header");
  if (!Array.isArray(data.components)) fail("components must be an array");

  const components: ComponentSpec[] = [];
  const code = new Map<string, string>();
  const ids = new Set<string>();
  const exported = new Set<string>();
  for (const entry of data.components) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      fail("invalid component");
    const item = entry as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== "string" || !IDENTIFIER.test(id) || ids.has(id))
      fail("invalid or duplicate component id: " + String(id));
    ids.add(id);
    const symbols = stringArray(item.symbols, id + ".symbols");
    const requires = stringArray(item.requires, id + ".requires");
    if (!symbols.every((name) => IDENTIFIER.test(name)))
      fail("invalid symbols for " + id);
    for (const name of symbols) {
      if (exported.has(name)) fail("duplicate exported symbol: " + name);
      exported.add(name);
    }
    if (!requires.every((name) => IDENTIFIER.test(name)))
      fail("invalid dependencies for " + id);
    let body: string;
    let location: Pick<ComponentSpec, "code" | "source">;
    if (data.schemaVersion === 2) {
      if (typeof item.code !== "string" || !item.code.trim()) fail("missing inline code for " + id);
      body = item.code;
      location = { code: body };
    } else {
      if (typeof item.source !== "string" || !item.source.endsWith(".h"))
        fail("source must be a relative .h path for " + id);
      const candidate = path.resolve(base, item.source);
      const relative = path.relative(base, candidate);
      if (!relative || relative === ".." || relative.startsWith(".." + path.sep) ||
          path.isAbsolute(relative))
        fail("source escapes preset directory: " + item.source);
      const resolved = await fs.realpath(candidate);
      const safe = path.relative(base, resolved);
      if (!safe || safe === ".." || safe.startsWith(".." + path.sep) ||
          path.isAbsolute(safe))
        fail("source resolves outside preset directory: " + item.source);
      body = await fs.readFile(resolved, "utf8");
      location = { source: item.source };
    }
    if (/^\s*#\s*include\b/m.test(body))
      fail(id + " must declare systemHeaders in the manifest, not #include");
    code.set(id, body.endsWith("\n") ? body : body + "\n");
    components.push({
      id,
      description: typeof item.description === "string" ? item.description : undefined,
      symbols,
      requires,
      ...location
    });
  }

  const byId = new Map(components.map((item) => [item.id, item]));
  const states = new Map<string, number>();
  const order: string[] = [];
  function visit(id: string): void {
    if (!byId.has(id)) fail("unknown dependency: " + id);
    if (states.get(id) === 1) fail("cyclic dependency involving " + id);
    if (states.get(id) === 2) return;
    states.set(id, 1);
    for (const dependency of byId.get(id)!.requires) visit(dependency);
    states.set(id, 2);
    order.push(id);
  }
  for (const item of components) visit(item.id);
  function readOptional(file: string) {
    const artifact = path.join(base, file);
    return fs.lstat(artifact)
      .then(stat => stat.isFile() ? fs.readFile(artifact, "utf8") : undefined)
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      });
  }
  const [manual, reference] = await Promise.all([readOptional(PRESET_MANUAL), readOptional(PRESET_REFERENCE)]);
  return {
    manifest: {
      schemaVersion: data.schemaVersion,
      ...(data.schemaVersion === 2 ? { languageId: languages.c.id } : {}),
      id: data.id as string,
      language: "c",
      standard: "c99",
      headerFile: data.headerFile as string,
      systemHeaders,
      components
    },
    code,
    order,
    manual,
    reference
  };
}

function includeHeaders(preset: LoadedPreset): string {
  return preset.manifest.systemHeaders.map((name) => "#include <" + name + ">\n").join("");
}

function componentCode(preset: LoadedPreset, selected: Set<string>): string {
  return preset.order.filter((id) => selected.has(id))
    .map((id) => "\n" + preset.code.get(id)!).join("");
}

export function renderHeader(preset: LoadedPreset): string {
  const guard = "ACCODING_" + preset.manifest.headerFile
    .replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return "#ifndef " + guard + "\n#define " + guard + "\n" +
    includeHeaders(preset) +
    componentCode(preset, new Set(preset.order)) +
    "\n#endif\n";
}

/** Replace comments (and optionally literals) with spaces, preserving newlines. */
function maskC(source: string, literals: boolean, compact = false, cpp = false): string {
  let out = "";
  const number = /(?:[0-9]|\.[0-9])(?:[eEpP][+-]|[A-Za-z0-9_.]|'[A-Za-z0-9_])*/y;
  const rawStart = /(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/y;
  let state: "code" | "line" | "block" | "single" | "double" = "code";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (cpp && !/[A-Za-z_0-9]/.test(source[i - 1] ?? "")) {
        number.lastIndex = i;
        rawStart.lastIndex = i;
        const token = number.exec(source);
        if (token) {
          out += token[0];
          i = number.lastIndex - 1;
          continue;
        }
        const raw = rawStart.exec(source);
        if (raw) {
          const terminator = ")" + raw[1] + '"';
          const end = source.indexOf(terminator, rawStart.lastIndex);
          if (end < 0) return out + source.slice(i);
          out += source.slice(i, end + terminator.length);
          i = end + terminator.length - 1;
          continue;
        }
      }
      if (ch === "/" && next === "/") { state = "line"; out += compact ? " " : "  "; i++; continue; }
      if (ch === "/" && next === "*") { state = "block"; out += compact ? " " : "  "; i++; continue; }
      if (ch === "'" || ch === '"') {
        state = ch === "'" ? "single" : "double";
        out += literals ? " " : ch;
        continue;
      }
      out += ch;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        out += "\n";
        const before = i - (source[i - 1] === "\r" ? 2 : 1);
        if (source[before] !== "\\") state = "code";
      } else if (!compact) out += " ";
    } else if (state === "block") {
      if (ch === "*" && next === "/") {
        if (!compact) out += "  ";
        i++; state = "code";
      } else if (!compact) out += ch === "\n" ? "\n" : " ";
    } else if (ch === "\\") {
      out += literals ? " " : ch;
      if (next !== undefined) {
        out += literals && next !== "\n" ? " " : next;
        i++;
      }
    } else if (ch === (state === "single" ? "'" : '"')) {
      out += literals ? " " : ch;
      state = "code";
    } else out += literals && ch !== "\n" ? " " : ch;
  }
  return out;
}

export function quotedIncludes(source: string): Array<{ name: string; start: number; end: number }> {
  return [...maskC(source, false).matchAll(/(^[ \t]*#[ \t]*include[ \t]*")([^"\r\n]+)"/gm)]
    .map((match) => {
      const start = match.index + match[1].length;
      return { name: match[2], start, end: start + match[2].length };
    });
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Strip editable-source comments for the generated test and submission copy. */
export function stripSourceComments(source: string, cpp = false): string {
  return maskC(source, false, true, cpp);
}

/** Assemble only explicitly used exported symbols and their component dependencies. */
export function assembleC(
  source: string, preset: LoadedPreset, header = preset.manifest.headerFile,
  sourceName = "main.c"
): {
  code: string;
  components: string[];
  diagnosticCode: string;
} {
  const withoutComments = lines(maskC(source, false));
  const sourceLines = lines(source);
  if (sourceLines.length !== withoutComments.length)
    fail("cannot inspect source line boundaries");
  let includeAt = -1;
  for (let i = 0; i < sourceLines.length; i++) {
    const line = withoutComments[i].trim();
    if (!/^#\s*include\b/.test(line)) {
      if (line.startsWith("#")) fail("only #include is supported in solution source");
      continue;
    }
    const directive = /^#\s*include\s*(?:<([^>\n]+)>|"([^"\n]+)")\s*$/.exec(line);
    if (!directive) fail("unsupported #include directive at line " + (i + 1));
    if (directive[1]) continue; // Standard/system include remains in main.c.
    if (directive[2] !== header)
      fail("other local headers are unsupported in C99 single-file mode: " + directive[2]);
    if (includeAt !== -1) fail("exam header must be included exactly once");
    includeAt = i;
  }
  if (includeAt === -1) fail('missing #include "' + header + '"');
  const symbols = new Set(maskC(source, true).match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []);
  const userCode = maskC(source, true).replace(/^\s*#.*$/gm, "");
  const definitionsInUserCode = new Set([...userCode.matchAll(
    /\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/g
  )].map((match) => match[1]));
  const selected = new Set<string>();
  const byId = new Map(preset.manifest.components.map((component) => [component.id, component]));
  function select(id: string): void {
    if (selected.has(id)) return;
    selected.add(id);
    for (const dependency of byId.get(id)!.requires) select(dependency);
  }
  for (const component of preset.manifest.components) {
    for (const name of component.symbols) {
      if (definitionsInUserCode.has(name)) fail("solution defines a reserved preset function: " + name);
      if (symbols.has(name)) select(component.id);
    }
  }
  const definitions = includeHeaders(preset) + componentCode(preset, selected);
  const result = sourceLines.slice();
  result[includeAt] = definitions + "\n";
  const components = preset.order.filter((id) => selected.has(id));
  const diagnosticLines = sourceLines.slice();
  diagnosticLines[includeAt] = '#line 1 "preset/headers.h"\n' + includeHeaders(preset) +
    components.map(id => "\n#line 1 " + JSON.stringify("preset/" + id + ".c") +
      "\n" + preset.code.get(id)! + "\n").join("") +
    "\n#line " + (includeAt + 2) + " " + JSON.stringify(sourceName) + "\n";
  const diagnosticCode = "#line 1 " + JSON.stringify(sourceName) + "\n" + diagnosticLines.join("");
  return { code: stripSourceComments(result.join("")), components, diagnosticCode };
}

export async function initializeHeader(folder: string, preset: LoadedPreset): Promise<string> {
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, preset.manifest.headerFile);
  await fs.writeFile(target, renderHeader(preset), { encoding: "utf8", flag: "wx" });
  return target;
}
