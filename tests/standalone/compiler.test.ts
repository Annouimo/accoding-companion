import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compile } from "../../src/judge/judge";
import { runProcess } from "../../src/judge/process";
import { toolchain } from "../../src/standalone/workflow";

test("missing compiler is reported only when compilation is requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "accoding-compiler-"));
  try {
    const config = { ...toolchain(), c: path.join(root, "nonexistent-gcc"), cpp: path.join(root, "nonexistent-g++") };
    await assert.rejects(compile(path.join(root, "main.c"), "int main(void) {return 0;}", config), /未找到 C 编译器.*使用说明/);
    await assert.rejects(compile(path.join(root, "main.cpp"), "int main() {return 0;}", config), /未找到 C\+\+ 编译器.*使用说明/);
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
