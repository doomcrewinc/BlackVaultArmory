import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Guard: route handlers must not touch file bytes directly.
 *
 * Uploads are encrypted at rest (spec 3b). Every read or write of an uploaded
 * file goes through src/lib/files/storage.ts (`writeEncryptedFile`,
 * `readDecryptedFile`). A route that calls `fs.writeFile` / `readFile` (or
 * their Sync forms) can put plaintext on disk, or serve ciphertext, without
 * any other test noticing. This scans every `route.ts` under src/app and
 * fails on such a call.
 *
 * Only these four calls are checked, as named in the task. Streams
 * (createWriteStream) and appendFile are not; no route uses them today.
 */

const APP_DIR = path.resolve(__dirname, "../../app");

// Matches a call such as `fs.writeFile(`, `fsp.readFile (`, `readFileSync(`,
// `fs.promises.writeFile(`. Word boundaries keep `writeEncryptedFile` and
// `readDecryptedFile` out.
const BANNED_CALL = /\b(writeFile|writeFileSync|readFile|readFileSync)\s*\(/;

/**
 * Route files allowed to call the banned functions, relative to src/app,
 * each with why. Keep this list short. A file listed here that no longer
 * makes such a call fails the test, so the list cannot go stale.
 */
const ALLOW_LIST: Record<string, string> = {
  // Writes the SEALED backup envelope to the admin-configured
  // backupDestinationPath (src/app/api/backup/route.ts:85). Not the uploads
  // folder, and the payload is already encrypted by sealBackup.
  "api/backup/route.ts": "sealed backup to backupDestinationPath",
};

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (name === "route.ts") out.push(full);
  }
  return out;
}

function bannedCalls(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
      return BANNED_CALL.test(line);
    })
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe("route handlers do not read or write file bytes directly", () => {
  const files = routeFiles(APP_DIR);

  it("finds route files to scan", () => {
    // Guards against a broken path silently scanning nothing.
    expect(files.length).toBeGreaterThan(20);
  });

  it("no route.ts calls writeFile/readFile (use src/lib/files/storage.ts)", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(APP_DIR, file).split(path.sep).join("/");
      if (rel in ALLOW_LIST) continue;
      for (const hit of bannedCalls(file)) offenders.push(`src/app/${rel}:${hit}`);
    }
    expect(offenders, "use writeEncryptedFile/readDecryptedFile from @/lib/files/storage").toEqual([]);
  });

  it("every allow-listed file still exists and still needs its entry", () => {
    for (const rel of Object.keys(ALLOW_LIST)) {
      const file = path.join(APP_DIR, rel);
      expect(bannedCalls(file).length, `${rel} no longer needs the allow-list`).toBeGreaterThan(0);
    }
  });
});
