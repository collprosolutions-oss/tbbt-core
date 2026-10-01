/**
 * Test-only loader for check-job-aftercare.mjs.
 * Resolves "@/..." to src/*.ts or src/*.tsx and transpiles JSX so the
 * ProjectAftercare escape proof can render the real component.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const ts = createRequire(import.meta.url)("typescript");

function aliasCandidates(specifier) {
  const rel = specifier.slice(2);
  return [
    new URL(`src/${rel}.ts`, repoRoot),
    new URL(`src/${rel}.tsx`, repoRoot),
    new URL(`src/${rel}/index.ts`, repoRoot),
    new URL(`src/${rel}/index.tsx`, repoRoot),
  ];
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = aliasCandidates(specifier).find((url) =>
      existsSync(fileURLToPath(url)),
    );
    if (!target) {
      return nextResolve(specifier, context);
    }
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) {
    return nextLoad(url, context);
  }
  const fileName = fileURLToPath(url);
  const { outputText } = ts.transpileModule(readFileSync(fileName, "utf8"), {
    fileName,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  return {
    format: "module",
    source: outputText,
    shortCircuit: true,
  };
}
