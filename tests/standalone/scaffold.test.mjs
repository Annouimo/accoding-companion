import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assembleC, initializeHeader, loadPreset, renderHeader, stripSourceComments } from "../../src/standalone/scaffold.ts";

const manifest = fileURLToPath(new URL("../../scaffold/presets/example-c99/manifest.json", import.meta.url));

test("example preset loads and generates a complete include-compatible header", async () => {
  const preset = await loadPreset(manifest);
  assert.deepEqual(preset.order, ["gcd_u64", "lcm_u64"]);
  const header = renderHeader(preset);
  assert.match(header, /#ifndef ACCODING_EXAM_H/);
  assert.match(header, /static unsigned long long exam_gcd_u64/);
  assert.match(header, /static unsigned long long exam_lcm_u64/);
  assert.ok(header.indexOf("exam_gcd_u64") < header.indexOf("exam_lcm_u64"));
});

test("only referenced API and transitive dependencies are expanded", async () => {
  const preset = await loadPreset(manifest);
  const gcdSource = [
    '#include <stdio.h>',
    '#include "exam.h"',
    'int main(void) {',
    '  const char *text = "exam_lcm_u64";',
    '  // exam_lcm_u64 must not activate a component',
    '  printf("%llu\n", exam_gcd_u64(18, 12));',
    '  return text[0] == 0;',
    '}'
  ].join("\n");
  const gcd = assembleC(gcdSource, preset);
  assert.deepEqual(gcd.components, ["gcd_u64"]);
  assert.doesNotMatch(gcd.code, /static unsigned long long exam_lcm_u64/);
  assert.doesNotMatch(gcd.code, /#include "exam.h"/);
  assert.doesNotMatch(gcd.code, /must not activate/);
  assert.doesNotMatch(gcd.code, /#line/);
  assert.match(gcd.diagnosticCode, /#line 3 "main\.c"/);
  assert.match(gcd.diagnosticCode, /must not activate/);
  assert.match(gcd.code, /#include <stdio.h>/);
  const lcm = assembleC(
    '#include "exam.h"\nunsigned long long f(void) { return exam_lcm_u64(12, 18); }\n',
    preset
  );
  assert.deepEqual(lcm.components, ["gcd_u64", "lcm_u64"]);
});

test("unsupported local includes and conditional exam includes fail", async () => {
  const preset = await loadPreset(manifest);
  assert.throws(() => assembleC(
    '#include "exam.h"\nunsigned long long exam_lcm_u64(unsigned long long a, unsigned long long b) { return a+b; }',
    preset
  ), /reserved preset function/);
  assert.throws(
    () => assembleC('#include "other.h"\n#include "exam.h"\n', preset),
    /other local headers/
  );
  assert.throws(
    () => assembleC('#if 1\n#include "exam.h"\n#endif\n', preset),
    /only #include/
  );
  assert.throws(
    () => assembleC('int main(void) { return 0; }\n', preset),
    /missing #include/
  );
});

test("dependency errors and unsafe source paths are rejected", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-test-"));
  try {
    const original = JSON.parse(await fs.readFile(manifest, "utf8"));
    const source = path.join(temp, "component.h");
    await fs.writeFile(source, "static int demo(void) { return 1; }\n");
    original.components = [{
      id: "demo", symbols: ["demo"], source: "component.h", requires: ["missing"]
    }];
    const file = path.join(temp, "manifest.json");
    await fs.writeFile(file, JSON.stringify(original));
    await assert.rejects(loadPreset(file), /unknown dependency/);
    original.components[0].requires = [];
    original.components[0].source = "../outside.h";
    await fs.writeFile(file, JSON.stringify(original));
    await assert.rejects(loadPreset(file), /escapes preset directory/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("header initialization never overwrites existing file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-init-"));
  try {
    const preset = await loadPreset(manifest);
    await initializeHeader(temp, preset);
    await assert.rejects(initializeHeader(temp, preset), { code: "EEXIST" });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("inline v2 snapshots preserve declaration selection and offline reference", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "scaffold-v2-"));
  try {
    const { saveSharedPreset } = await import("../../src/standalone/preset-manager.ts");
    const source = path.join(temp, "package");
    await fs.mkdir(source);
    const input = {
      schemaVersion: 2, id: "numbers", languageId: "c99", language: "c",
      standard: "c99", headerFile: "exam.h", systemHeaders: [],
      components: [
        { id: "helper", symbols: [], requires: [], code: "static int helper(void) { return 42; /* strip library comment */ }\n" },
        { id: "read_int", symbols: ["read_int"], requires: ["helper"],
          code: "static int read_int(void) { return helper(); }\n" },
        { id: "read_ll", symbols: ["read_ll"], requires: [],
          code: "static long long read_ll(void) { return 0; }\n" }
      ]
    };
    await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(input));
    await fs.writeFile(path.join(source, "reference.json"), JSON.stringify({ schemaVersion: 1, categories: [] }));
    const original = await loadPreset(source);
    const root = path.join(temp, "course");
    await fs.mkdir(root);
    const saved = await saveSharedPreset(root, original, "0.6.7");
    await fs.rm(source, { recursive: true });
    const snapshot = await loadPreset(saved.directory);
    assert.equal(snapshot.reference, original.reference);
    assert.match(await fs.readFile(path.join(saved.directory, "expanded.h"), "utf8"), /read_ll/);
    const result = assembleC('#include "exam.h"\nint main(void) { return read_int(); }', snapshot);
    assert.deepEqual(result.components, ["helper", "read_int"]);
    assert.doesNotMatch(result.code, /strip library comment/);
    assert.match(result.diagnosticCode, /strip library comment/);
    assert.deepEqual(assembleC('#include "exam.h"\nint main(void) { int helper = 0; return helper; }', snapshot)
      .components, []);
    await assert.rejects(fs.stat(path.join(saved.directory, "components")), { code: "ENOENT" });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("stripping comments retains token separation and literal content", () => {
  assert.equal(stripSourceComments("#define VALUE 1 /* note\ncontinued */+ 2\n"),
    "#define VALUE 1  + 2\n");
  assert.equal(stripSourceComments('int/**/a; // remove\nchar *s = "https://example.org/*keep*/";'),
    'int a;  \nchar *s = "https://example.org/*keep*/";');
  assert.equal(stripSourceComments('auto s = R"delim(" // raw /* data */)delim"; // remove\nint n = 1\'000;', true),
    'auto s = R"delim(" // raw /* data */)delim";  \nint n = 1\'000;');
});
