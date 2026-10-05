import path from "node:path";

/**
 * Joins the segments under `root` and returns the absolute result. Throws when
 * the result is not strictly inside `root` (a `..` or a separator in a segment).
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep)) {
    throw new Error("Refusing a file path outside its folder");
  }
  return resolved;
}
