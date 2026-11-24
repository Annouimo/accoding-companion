import type { Binding, Target } from "../model";

import languages from "./languages.json";

export { languages };
export const languageChoices = Object.entries(languages).map(([value, profile]) => ({
  value: value as keyof typeof languages, label: profile.label
}));
export const cTemplate = languages.c.template;
export const cppTemplate = languages.cpp.template;

export function defaultSourceFiles(target: Target) {
  const base =
    target.kind === "problemset"
      ? `problems/${target.problemId}`
      : `contests/${target.contestId}/${target.problemId}`;
  return { c: `${base}/${languages.c.file}`, cpp: `${base}/${languages.cpp.file}` };
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
