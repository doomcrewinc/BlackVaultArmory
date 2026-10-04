import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * pg-real-db-tests.mjs runs the files in pg-real-db-files.json on PostgreSQL.
 * A test file that reads a PostgreSQL URL but is missing from that list would
 * skip itself in CI and never run there, so this compares the list with the
 * files found on disk.
 */
const ROOT = process.cwd();
// Any PG/POSTGRES variable except the runner's own admin URL.
const PG_VARIABLE = /process\.env\.(?!PG_REAL_DB_ADMIN_URL\b)[A-Z_]*(?:PG|POSTGRES)[A-Z_]*/;

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...testFiles(relative));
    else if (/\.test\.tsx?$/.test(entry.name)) found.push(relative);
  }
  return found;
}

describe("pg-real-db-files.json", () => {
  it("lists exactly the test files that read a PostgreSQL URL variable", () => {
    const readers = [...testFiles("src"), ...testFiles("scripts")]
      .filter((file) => file !== "scripts/ci/pg-real-db-files.test.ts")
      .filter((file) => PG_VARIABLE.test(readFileSync(path.join(ROOT, file), "utf8")))
      .sort();
    const listed = (JSON.parse(readFileSync(path.join(ROOT, "scripts/ci/pg-real-db-files.json"), "utf8")) as string[]).sort();
    expect(listed).toEqual(readers);
  });
});
