import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepValueError, parseKeep, pruneFullBackups, PUBLISHED_FULL_BACKUP_NAME } from "./full-prune";

let dir: string;
const name = (stamp: string) => `blackvault-full-${stamp}.bvb`;
const put = (file: string, content = "x") => fs.writeFileSync(path.join(dir, file), content);
const listing = () => fs.readdirSync(dir).sort();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-full-prune-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseKeep", () => {
  it.each([["1", 1], ["7", 7], ["007", 7], ["100000", 100000]])("accepts %s", (text, n) => {
    expect(parseKeep(text)).toBe(n);
  });

  it.each(["0", "000", "-1", "+3", "1.5", "2e3", "0x10", " 3", "3 ", "", "seven", "1000000", "100001", "٣", "3\n"])("rejects %j", (text) => {
    expect(() => parseKeep(text)).toThrow(KeepValueError);
  });

  it("the error does not echo the value (it could be a misplaced passphrase)", () => {
    const err = (() => {
      try {
        parseKeep("my-secret-passphrase");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/whole number/);
    expect(err?.message).not.toContain("my-secret-passphrase");
  });
});

describe("pruneFullBackups", () => {
  const A = name("20261001-010101");
  const B = name("20261001-020202");
  const C = name("20261002-000000");
  const D = name("20261002-180405");

  it("keep=2 with 4 backups deletes exactly the 2 oldest, oldest first", async () => {
    for (const f of [C, A, D, B]) put(f);
    const r = await pruneFullBackups(dir, 2, D);
    expect(r).toEqual({ deleted: [A, B], warnings: [] });
    expect(listing()).toEqual([C, D]);
  });

  it("deletes nothing when there are no more than `keep` backups", async () => {
    for (const f of [A, B]) put(f);
    expect(await pruneFullBackups(dir, 2, B)).toEqual({ deleted: [], warnings: [] });
    expect(await pruneFullBackups(dir, 7, B)).toEqual({ deleted: [], warnings: [] });
    expect(listing()).toEqual([A, B]);
  });

  it("only exact published names are candidates: work files, the lock, renamed copies, folders and symlinks are never touched or counted", async () => {
    for (const f of [A, B, C, D]) put(f);
    const others = [
      "blackvault-full-20200101-000000.0123456789abcdef.bvb.partial", // a work file, older than everything
      ".full-backup.lock",
      "blackvault-full-20200101-000000-offsite.bvb",
      "blackvault-full-20200101-000000.bvb.bak",
      "xblackvault-full-20200101-000000.bvb",
      "blackvault-full-2020010-000000.bvb",
      "blackvault-20200101-000000.db",
      "notes.txt",
    ];
    for (const f of others) put(f);
    fs.mkdirSync(path.join(dir, name("20200101-000001"))); // a FOLDER with a published name
    const outside = path.join(dir, "notes.txt");
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(dir, name("20200101-000002"))); // a SYMLINK with a published name
      linked = true;
    } catch {
      // Windows without the symlink privilege.
    }

    const r = await pruneFullBackups(dir, 1, D);
    expect(r).toEqual({ deleted: [A, B, C], warnings: [] });
    const expected = [...others, name("20200101-000001"), D];
    if (linked) expected.push(name("20200101-000002"));
    expect(listing()).toEqual(expected.sort());
    expect(fs.readFileSync(outside, "utf8")).toBe("x");
  });

  it("orders by the timestamp in the NAME, not by file times", async () => {
    for (const f of [A, B, C, D]) put(f);
    // The oldest name gets the newest mtime, the newest name the oldest.
    fs.utimesSync(path.join(dir, A), new Date(), new Date());
    fs.utimesSync(path.join(dir, D), new Date(0), new Date(0));
    const r = await pruneFullBackups(dir, 3, D);
    expect(r.deleted).toEqual([A]);
  });

  it("the backup just made is never deleted, even when its name is not among the newest `keep` (clock set back)", async () => {
    for (const f of [A, B, C, D]) put(f);
    const r = await pruneFullBackups(dir, 2, A); // A is the OLDEST name
    expect(r).toEqual({ deleted: [B], warnings: [] });
    expect(listing()).toEqual([A, C, D]);
  });

  it("deletes NOTHING and warns when the backup just made is not in the folder, or is not a published name", async () => {
    for (const f of [A, B, C]) put(f);
    const missing = await pruneFullBackups(dir, 1, D);
    expect(missing.deleted).toEqual([]);
    expect(missing.warnings).toHaveLength(1);
    expect(missing.warnings[0]).toContain(D);
    expect(missing.warnings[0]).toContain(dir);

    put("blackvault-full-20261002-180405.0123456789abcdef.bvb.partial");
    const partial = await pruneFullBackups(dir, 1, "blackvault-full-20261002-180405.0123456789abcdef.bvb.partial");
    expect(partial.deleted).toEqual([]);
    expect(partial.warnings).toHaveLength(1);
    expect(listing()).toHaveLength(4);
  });

  it("a file that cannot be deleted is a warning naming it; the others are still deleted", async () => {
    for (const f of [A, B, C, D]) put(f);
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, "unlink").mockImplementation(async (p) => {
      if (String(p).endsWith(A)) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES", syscall: "unlink" });
      return realUnlink(p);
    });
    const r = await pruneFullBackups(dir, 1, D);
    expect(r.deleted).toEqual([B, C]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(A);
    expect(r.warnings[0]).toContain("EACCES");
    expect(listing()).toEqual([A, D]);
  });

  it("refuses a keep below 1 or a fraction, deleting nothing", async () => {
    for (const f of [A, B, C, D]) put(f);
    await expect(pruneFullBackups(dir, 0, D)).rejects.toBeInstanceOf(KeepValueError);
    await expect(pruneFullBackups(dir, 1.5, D)).rejects.toBeInstanceOf(KeepValueError);
    expect(listing()).toHaveLength(4);
  });

  it("the published-name pattern is anchored on both ends", () => {
    expect(PUBLISHED_FULL_BACKUP_NAME.test(D)).toBe(true);
    expect(PUBLISHED_FULL_BACKUP_NAME.test(`${D}.partial`)).toBe(false);
    expect(PUBLISHED_FULL_BACKUP_NAME.test(`a${D}`)).toBe(false);
    expect(PUBLISHED_FULL_BACKUP_NAME.test("blackvault-full-20261002-180405.0123456789abcdef.bvb")).toBe(false);
  });
});
