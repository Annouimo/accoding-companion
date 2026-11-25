import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compile } from "../../src/judge/judge";
import { runProcess } from "../../src/judge/process";
import { toolchain } from "../../src/standalone/workflow";
import { parseCompilerDiagnostics, preferMappedDiagnostics, attachDiagnosticContext } from "../../src/standalone/compiler-diagnostics";
import { lineDiff } from "../../src/standalone/line-diff";

test("missing compiler is reported only when compilation is requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-compiler-"));
  try {
    const config = { ...toolchain(), c: path.join(root, "nonexistent-gcc"), cpp: path.join(root, "nonexistent-g++") };
    await assert.rejects(compile(path.join(root, "main.c"), "int main(void) {return 0;}", config), /未找到 C 编译器.*请安装编译器/);
    await assert.rejects(compile(path.join(root, "main.cpp"), "int main() {return 0;}", config), /未找到 C\+\+ 编译器.*请安装编译器/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("external C and C++ compilers work in a Unicode workspace; syntax errors stay compiler errors", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-compiler-"));
  const root = path.join(parent, "中文 工作区");
  await fs.mkdir(root);
  const config = toolchain();
  try {
    for (const [ext, code] of [
      [".c", "#include <stdio.h>\nint main(void) { puts(\"42\"); return 0; }\n"],
      [".cpp", "#include <iostream>\nint main() { std::cout << 42 << '\\n'; }\n"],
    ]) {
      const built = await compile(path.join(root, "main" + ext), code, config);
      try {
        assert.equal(built.result.exitCode, 0, built.result.stderr);
        const result = await runProcess(built.program, [], {
          cwd: root, env: built.env, timeoutMs: 5000, outputLimit: 8192
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.stdout.trim(), "42");
      } finally {
        await fs.rm(built.directory, { recursive: true, force: true });
      }
    }
    const invalid = await compile(path.join(root, "main.c"), "this is not C", config);
    try {
      assert.notEqual(invalid.result.exitCode, 0);
      assert.ok(invalid.result.stderr.length);
      assert.doesNotMatch(invalid.result.stderr, /未找到 C 编译器/);
    } finally {
      await fs.rm(invalid.directory, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("compiler diagnostic grouping preserves notes, unknown messages and Windows paths", () => {
  const raw = "C:\\中文\\main.c:7:9: warning: unused variable 'index' [-Wunused-variable]\n" +
    "  int index = 1;\nC:\\中文\\main.c:3:2: note: related location\n";
  const result = {stdout:"", stderr:raw, exitCode:0, signal:null, elapsedMs:1};
  const diagnostics = parseCompilerDiagnostics(result);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].location, "C:\\中文\\main.c:7:9");
  assert.match(diagnostics[0].explanation!, /未被使用/);
  assert.match(diagnostics[0].raw, /note: related location/);
  assert.equal(parseCompilerDiagnostics({...result, stderr:"unknown linker output", exitCode:1})[0].raw, "unknown linker output");
  assert.equal(preferMappedDiagnostics(result, {...result, stderr:"main.c:99: warning: another warning"})[0].location, diagnostics[0].location);
});

test("comment-preserving #line diagnostics do not change formal source or hide warnings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-mapping-"));
  const config = toolchain();
  const code = "int main(void) {\n/* comment\n second line */\n int index = 0;\n return 0;\n}\n";
  try {
    const formal = await compile(path.join(root,"main.c"), code.replace(/\/\*[\s\S]*?\*\//, " "), config);
    try {
      const mapped = await compile(path.join(root,"main.c"), '#line 1 "main.c"\n' + code, config);
      try {
        assert.equal(formal.result.exitCode,0,formal.result.stderr);
        assert.equal(mapped.result.exitCode,0,mapped.result.stderr);
        const diagnostics = preferMappedDiagnostics(formal.result,mapped.result);
        assert.ok(diagnostics.some(d => d.location?.endsWith("main.c:4:6") || /main\.c:4(?::\d+)?$/.test(d.location ?? "")), mapped.result.stderr);
      } finally { await fs.rm(mapped.directory,{recursive:true,force:true}); }
    } finally { await fs.rm(formal.directory,{recursive:true,force:true}); }
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test("inline diff highlights only changed characters, including insertions and Unicode", () => {
  const changed = (a: string,b: string) => lineDiff(a,b).map(parts => parts.filter(p => p.changed).map(p=>p.text).join(""));
  assert.deepEqual(changed("David 85 91","David 83 91"),["5","3"]);
  assert.deepEqual(changed("Bob 89 96","Bob 89 69"),["96","69"]);
  assert.deepEqual(changed("12345678","123678"),["45",""]);
  assert.deepEqual(changed("你好😀世界","你好😁世界"),["😀","😁"]);
  assert.deepEqual(changed("a b","a  b"),[""," "]);
  assert.deepEqual(changed("a".repeat(30000)+"X","a".repeat(30000)+"Y"),["X","Y"]);
});

test("mapped source contexts preserve comments and distinguish preset origins", () => {
  const result = {stdout:"", stderr:"main.c:4:6: warning: unused variable 'index' [-Wunused-variable]\npreset/io.c:2:1: warning: unused variable 'x' [-Wunused-variable]", exitCode:0, signal:null, elapsedMs:1};
  const source = '#line 1 "main.c"\n/* comment\n end */\n#line 1 "preset/io.c"\nint f(void) {\n int x;\n}\n#line 4 "main.c"\n int index;\n return 0;\n';
  const diagnostics = attachDiagnosticContext(parseCompilerDiagnostics(result),source,"main.c",true);
  assert.equal(diagnostics[0].title,"未使用的变量");
  assert.equal(diagnostics[0].origin,"user");
  assert.equal(diagnostics[0].context?.find(x=>x.focus)?.text," int index;");
  assert.equal(diagnostics[1].origin,"preset");
  assert.equal(diagnostics[1].context?.find(x=>x.focus)?.line,2);
});
