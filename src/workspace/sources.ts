import type { Binding, Target } from "../model";

export const cTemplate =
  "#include <stdio.h>\n\nint main() {\n    return 0;\n}\n";
// Expanded from the local VS Code Codeforces snippet; $0 is the editing cursor.
export const cppTemplate =
  "#include <iostream>\n\nint main() {\n    return 0;\n}\n";

export function defaultSourceFiles(target: Target) {
  const base =
    target.kind === "problemset"
      ? `problems/${target.problemId}`
      : `contests/${target.contestId}/${target.problemId}`;
  return { c: `${base}/main.c`, cpp: `${base}/main.cpp` };
}
export function sourceLanguage(file: string): "c" | "cpp" {
  return /\.c$/i.test(file) ? "c" : "cpp";
}
export function localSourceChoices(binding: Binding) {
  const files = defaultSourceFiles(binding.problem.target);
  files[sourceLanguage(binding.sourceFile)] = binding.sourceFile;
  return [
    { label: "C", description: files.c, sourceFile: files.c },
    { label: "C++", description: files.cpp, sourceFile: files.cpp },
  ].sort(
    (a, b) =>
      Number(b.sourceFile === binding.sourceFile) -
      Number(a.sourceFile === binding.sourceFile),
  );
}
export function managedSourceFiles(binding: Binding) {
  return [
    ...new Set([
      ...Object.values(defaultSourceFiles(binding.problem.target)),
      binding.sourceFile,
    ]),
  ];
}
