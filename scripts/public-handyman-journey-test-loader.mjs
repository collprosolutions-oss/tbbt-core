/**
 * Test loader for the public Handyman customer journey check.
 * Next.js mocks + @/ aliases, including .tsx for portal escape proofs.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const here = import.meta.url;
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
  if (specifier === "next/cache") {
    return { shortCircuit: true, url: new URL("./mocks/next-cache.mjs", here).href };
  }
  if (specifier === "next/navigation") {
    return { shortCircuit: true, url: new URL("./mocks/next-navigation.mjs", here).href };
  }
  if (specifier === "next/headers") {
    return { shortCircuit: true, url: new URL("./mocks/next-headers.mjs", here).href };
  }
  if (specifier.startsWith("next/") && !specifier.endsWith(".js")) {
    return nextResolve(`${specifier}.js`, context);
  }
  if (specifier === "server-only") {
    return { shortCircuit: true, url: new URL("./mocks/server-only.mjs", here).href };
  }
  if (specifier === "@/lib/saas-billing/enforce") {
    return { shortCircuit: true, url: new URL("./mocks/saas-enforce.mjs", here).href };
  }
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
