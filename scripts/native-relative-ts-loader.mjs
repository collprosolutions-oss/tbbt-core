/**
 * Resolve extensionless relative imports to sibling `.ts` files so a
 * Node `--experimental-strip-types` script can import apps/native
 * helpers that Expo/Metro resolves without extensions.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  const leaf = specifier.split("/").pop() ?? "";
  if (specifier.startsWith(".") && !leaf.includes(".")) {
    const parent = context.parentURL;
    if (parent) {
      const tsTarget = new URL(`${specifier}.ts`, parent);
      if (existsSync(fileURLToPath(tsTarget))) {
        return nextResolve(tsTarget.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
