import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPublicPath } from "./auth-gate";

const ROOT = path.resolve(__dirname, "../../..");
const FOLDERS = ["src/app/api/capture", "src/app/capture"];

const EXPECTED_FILES = [
  "src/app/api/capture/[token]/route.test.ts",
  "src/app/api/capture/[token]/route.ts",
  "src/app/api/capture/[token]/upload/route.test.ts",
  "src/app/api/capture/[token]/upload/route.ts",
  "src/app/capture/[token]/error.tsx",
  "src/app/capture/[token]/page.tsx",
];

const EXPECTED_METHODS: Record<string, string[]> = {
  "src/app/api/capture/[token]/route.ts": ["GET"],
  "src/app/api/capture/[token]/upload/route.ts": ["POST"],
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const WARNING =
  "Everything under src/app/capture and src/app/api/capture is public by prefix " +
  "(PUBLIC_PREFIXES in src/lib/server/auth-gate.ts): no sign-in is needed to reach it. " +
  "If this change is intended, review it as a change to the app's unauthenticated surface, " +
  "then update the expected list in this test.";

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : [rel];
  });
}

function exportedMethods(source: string): string[] {
  const found = new Set<string>();
  for (const method of HTTP_METHODS) {
    const declared = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`);
    const listed = new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`);
    if (declared.test(source) || listed.test(source)) found.add(method);
  }
  return [...found].sort();
}

describe("public capture surface", () => {
  it("is public by prefix, which is why this test exists", () => {
    expect(isPublicPath("/capture/x")).toBe(true);
    expect(isPublicPath("/api/capture/x")).toBe(true);
    expect(isPublicPath("/api/capture/x/upload")).toBe(true);
  });

  it("holds exactly the expected files", () => {
    const files = FOLDERS.flatMap(walk).sort();
    expect(files, WARNING).toEqual([...EXPECTED_FILES].sort());
  });

  it.each(Object.entries(EXPECTED_METHODS))("%s exports exactly %j", (file, methods) => {
    const source = readFileSync(path.join(ROOT, file), "utf8");
    expect(exportedMethods(source), WARNING).toEqual(methods);
  });

  it("recognises the ways a method can be exported", () => {
    expect(exportedMethods("export async function GET() {}")).toEqual(["GET"]);
    expect(exportedMethods("export const POST = () => {};")).toEqual(["POST"]);
    expect(exportedMethods("const a = 1; export { a as b, DELETE };")).toEqual(["DELETE"]);
    expect(exportedMethods("export const dynamic = 'x'; export function getThing() {}")).toEqual([]);
  });
});
