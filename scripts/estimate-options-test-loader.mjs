/**
 * Test loader: Next.js mocks + @/ path aliases so check-estimate-options
 * can import the real send/approve/createJob server actions.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const here = import.meta.url;

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
  if (specifier === "next/server") {
    return { shortCircuit: true, url: new URL("./mocks/next-server.mjs", here).href };
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
    const fileTarget = new URL(`src/${specifier.slice(2)}.ts`, repoRoot);
    const indexTarget = new URL(`src/${specifier.slice(2)}/index.ts`, repoRoot);
    const target = existsSync(fileURLToPath(fileTarget)) ? fileTarget : indexTarget;
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
