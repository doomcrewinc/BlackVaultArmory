/**
 * scripts/entry/reencrypt-files.ts, bundled exactly as the image ships it
 * (scripts/build-scripts.mjs → <out>/reencrypt-files.mjs) and run under
 * plain `node` as a child process against a scratch uploads folder. This
 * pins the contract reencrypt-files.sh / .bat build on: the old key comes
 * from standard input only, the one-line stdout format, the exit codes
 * (0 re-encrypted, 3 nothing to do or a bad key, 1 failed).
 *
 * What the engine does file by file (a mixed folder, a failure halfway, the
 * app's startup afterwards) is in src/lib/files/reencrypt.real-fs.test.ts.
 *
 * This test lives in scripts/, NOT scripts/entry/: the build bundles every
 * `*.ts` in scripts/entry/ as an entry point, a test file included.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildScripts } from "./build-scripts.mjs";
import { decryptFile, deriveKeys, encryptFile, fileKeyId, type FieldKeys } from "@/lib/encryption/core.mjs";

const ROOT = path.resolve(__dirname, "..");
const OLD_HEX = "11".repeat(32);
const CURRENT_HEX = "ab".repeat(32); // NOT the vitest key: the child gets its key from its own environment
const OLD = deriveKeys(Buffer.from(OLD_HEX, "hex"));
const CURRENT = deriveKeys(Buffer.from(CURRENT_HEX, "hex"));
const THIRD = deriveKeys(Buffer.from("22".repeat(32), "hex"));
const isPosixNonRoot = process.platform !== "win32" && process.getuid?.() !== 0;

let tmp: string;
let outDir: string;
let bundle: string;
let uploads: string;
let seq = 0;

function put(rel: string, keys: FieldKeys | null, plain: string) {
  const abs = path.join(uploads, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, keys ? encryptFile(keys, path.basename(rel), Buffer.from(plain)) : plain);
}
const idOf = (rel: string) => fileKeyId(fs.readFileSync(path.join(uploads, rel)));
const plainOf = (rel: string, keys: FieldKeys) => decryptFile(keys, path.basename(rel), fs.readFileSync(path.join(uploads, rel))).toString();
const all = () => Object.fromEntries(fs.readdirSync(uploads, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
  const abs = path.join(e.parentPath, e.name);
  return [path.relative(uploads, abs), `${fs.statSync(abs).mtimeMs}:${fs.readFileSync(abs).toString("hex")}`];
}));

function cli(input: string | Buffer, opts: { args?: string[]; env?: Record<string, string | undefined> } = {}) {
  const env = {
    PATH: process.env.PATH,
    IMAGE_UPLOAD_DIR: uploads,
    BLACKVAULT_ENCRYPTION_KEY: CURRENT_HEX,
    BLACKVAULT_ENCRYPTION_KEY_FILE: path.join(tmp, "no-such-key-file"),
    ...opts.env,
  } as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [bundle, ...(opts.args ?? [])], { cwd: tmp, env, input, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-reencrypt-cli-"));
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  outDir = fs.mkdtempSync(path.join(ROOT, "dist", "bv-test-out-"));
  const built = await buildScripts({ outDir });
  bundle = path.join(outDir, "reencrypt-files.mjs");
  expect(built).toContain(bundle);
}, 120_000);

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

beforeEach(() => {
  uploads = path.join(tmp, `uploads-${seq++}`);
  put("images/a.jpg", OLD, "image a");
  put("documents/d.pdf", OLD, "document d");
  put("images/cur.jpg", CURRENT, "current");
  put("images/third.jpg", THIRD, "third");
  put("images/plain.txt", null, "plain");
});

describe("dist/scripts/reencrypt-files.mjs (the bundle, under plain node)", () => {
  it("the bundle needs no database: it holds no Prisma client", () => {
    const text = fs.readFileSync(bundle, "utf8");
    expect(text).not.toMatch(/@prisma\/client|\.prisma\/client/);
  });

  it("exit 0: the old key on stdin (as the key file's bytes, with its line ending) re-encrypts the old-key files; one stdout line; the key is never printed", () => {
    const r = cli(`${OLD_HEX}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("BLACKVAULT_REENCRYPT_OK reencrypted=2 already_current=1 unknown_key=1 not_encrypted=1 failed=0\n");
    expect(idOf("images/a.jpg")).toBe(CURRENT.id);
    expect(plainOf("images/a.jpg", CURRENT)).toBe("image a");
    expect(plainOf("documents/d.pdf", CURRENT)).toBe("document d");
    expect(plainOf("images/third.jpg", THIRD)).toBe("third");
    expect(r.stderr).toMatch(/^WARNING: images\/third\.jpg is encrypted with key [0-9a-f]{8}, which is neither/m);
    expect(r.stderr).toMatch(/^WARNING: 1 file is encrypted with a key that is neither the old key nor the current one/m);
    expect(r.stderr).toMatch(/^reencrypt-files: re-encrypted 2 files under the current key \(1 already were\)\.$/m);
    expect(`${r.stdout}${r.stderr}`).not.toContain(OLD_HEX);
    expect(`${r.stdout}${r.stderr}`).not.toContain(CURRENT_HEX);
  });

  it("exit 3 on the second run: NOTHING, a clear line, and no file's bytes or mtime change", () => {
    expect(cli(`${OLD_HEX}\r\n`).status).toBe(0); // CRLF, as a key file written on Windows
    const before = all();
    const r = cli(`${OLD_HEX}\n`);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 already_current=3 unknown_key=1 not_encrypted=1 failed=0\n");
    expect(r.stderr).toMatch(/^reencrypt-files: nothing to do: no uploaded file is encrypted with the old key \(key id [0-9a-f]{8}\)\. 3 already under the current key, 1 under another key, 1 not encrypted\. Nothing was changed\.$/m);
    expect(all()).toEqual(before);
  });

  it("exit 3: a wrong key (valid format, matches nothing) changes nothing", () => {
    const before = all();
    const r = cli(`${"33".repeat(32)}\n`);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/^BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 /);
    expect(all()).toEqual(before);
  });

  it.each([
    ["empty", ""],
    ["too short", "11".repeat(31)],
    ["not hex", "this is not an encryption key at all"],
    ["two keys", `${OLD_HEX}\n${OLD_HEX}\n`],
  ])("exit 3 before anything is touched: an invalid old key (%s); nothing on stdout; the text is not echoed", (_name, text) => {
    const before = all();
    // An unreadable uploads folder would fail the run with exit 1 if it were looked at.
    const r = cli(text, { env: { IMAGE_UPLOAD_DIR: path.join(tmp, "not-looked-at") } });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("reencrypt-files: The old key file does not hold an encryption key: it must be 64 hex characters, like secrets/blackvault_encryption_key. Nothing was changed.\n");
    expect(all()).toEqual(before);
  });

  it("exit 3: the old key IS the current key — says so, nothing changed", () => {
    const before = all();
    const r = cli(`${CURRENT_HEX}\n`);
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^reencrypt-files: The old key file holds this install's CURRENT key \(key id [0-9a-f]{8}\), so there is nothing to re-encrypt\./);
    expect(all()).toEqual(before);
  });

  it("exit 1: no current key; and any argument is refused without being echoed", () => {
    const noKey = cli(`${OLD_HEX}\n`, { env: { BLACKVAULT_ENCRYPTION_KEY: undefined } });
    expect(noKey.status).toBe(1);
    expect(noKey.stdout).toBe("");
    expect(noKey.stderr).toMatch(/^reencrypt-files: No encryption key\./);

    const arg = cli(`${OLD_HEX}\n`, { args: [OLD_HEX] });
    expect(arg.status).toBe(1);
    expect(arg.stderr).toBe("reencrypt-files: unknown argument. Usage: reencrypt-files (no arguments); the old key is read from standard input.\n");
    expect(idOf("images/a.jpg")).toBe(OLD.id);
  });

  it("exit 1: an old-key file that does not decrypt is named and left alone; the others are re-encrypted; FAILED line", () => {
    const bad = path.join(uploads, "documents/d.pdf");
    const bytes = fs.readFileSync(bad);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(bad, bytes);
    const r = cli(`${OLD_HEX}\n`);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("BLACKVAULT_REENCRYPT_FAILED reencrypted=1 already_current=1 unknown_key=1 not_encrypted=1 failed=1\n");
    expect(r.stderr).toMatch(/^reencrypt-files: documents\/d\.pdf is under the old key but could not be decrypted with it/m);
    expect(fs.readFileSync(bad).equals(bytes)).toBe(true);
    expect(idOf("images/a.jpg")).toBe(CURRENT.id);
  });

  it.skipIf(!isPosixNonRoot)("exit 1: a folder that cannot be written stops the run; FAILED line with the counts; the file is whole; a second run finishes", () => {
    const docs = path.join(uploads, "documents");
    fs.chmodSync(docs, 0o500);
    let r;
    try {
      r = cli(`${OLD_HEX}\n`);
    } finally {
      fs.chmodSync(docs, 0o700);
    }
    expect(r.status).toBe(1);
    // images/ is gone through first: a.jpg was re-encrypted before documents/d.pdf could not be written.
    expect(r.stdout).toBe("BLACKVAULT_REENCRYPT_FAILED reencrypted=1 already_current=1 unknown_key=1 not_encrypted=1 failed=1\n");
    expect(r.stderr).toMatch(/^reencrypt-files: Could not write documents\/d\.pdf \(EACCES\); it was left as it was\. 1 file was re-encrypted before that\. .* run this again/m);
    expect(plainOf("documents/d.pdf", OLD)).toBe("document d");
    const again = cli(`${OLD_HEX}\n`);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toBe("BLACKVAULT_REENCRYPT_OK reencrypted=1 already_current=2 unknown_key=1 not_encrypted=1 failed=0\n");
  });
});
