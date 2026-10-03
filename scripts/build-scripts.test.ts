/**
 * scripts/build-scripts.mjs bundles scripts/entry/*.ts into dist/scripts/*.mjs
 * with esbuild (Task 3, docs/superpowers/specs/2026-10-02-full-backups-design.md).
 * No entry file is committed under scripts/entry/ (ruling R1) — every probe
 * here lives in a throwaway temp directory passed via entryDir/outDir.
 *
 * Whether the bundle can also resolve @prisma/client and run as uid 1001
 * INSIDE the built runner image is proven separately with a local `docker
 * build` + `docker run`, not in this suite (no Docker in CI unit tests).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildScripts } from "./build-scripts.mjs";

const ROOT = path.resolve(__dirname, "..");

let tmp: string;
let entryDir: string;
let outDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-build-scripts-"));
  entryDir = path.join(tmp, "entry");
  fs.mkdirSync(entryDir);
  // outDir lives under THIS repo's (gitignored) dist/, not an unrelated
  // os.tmpdir() path: Node's ESM resolver walks up from the FILE being run
  // looking for node_modules, never from process.cwd(). Only a location
  // with this repo's node_modules above it can resolve the externalized
  // "@prisma/client" import the way the real dist/scripts/*.mjs does once
  // copied into the runner image (Dockerfile places it at /app/dist/scripts,
  // with /app/node_modules above it).
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  outDir = fs.mkdtempSync(path.join(ROOT, "dist", "bv-test-out-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("buildScripts", () => {
  it("builds nothing, successfully, when the entry dir is empty", async () => {
    const built = await buildScripts({ entryDir, outDir });
    expect(built).toEqual([]);
    expect(fs.existsSync(outDir)).toBe(true);
  });

  it("builds nothing, successfully, when the entry dir does not exist at all — but still creates outDir (the Dockerfile COPYs it unconditionally)", async () => {
    const built = await buildScripts({ entryDir: path.join(tmp, "no-such-dir"), outDir });
    expect(built).toEqual([]);
    expect(fs.existsSync(outDir)).toBe(true);
  });

  it("bundles a probe importing @/lib/files/storage and @/lib/encryption/core.mjs, runnable with plain node", async () => {
    fs.writeFileSync(
      path.join(entryDir, "probe.ts"),
      [
        'import { uploadsRoot } from "@/lib/files/storage";',
        'import { FILE_MAGIC } from "@/lib/encryption/core.mjs";',
        "console.log(JSON.stringify({ root: uploadsRoot(), magic: FILE_MAGIC }));",
      ].join("\n"),
    );

    const built = await buildScripts({ entryDir, outDir });
    expect(built).toEqual([path.join(outDir, "probe.mjs")]);

    // Plain `node`, no loader/flags — this is how the image runs it
    // (`node dist/scripts/<name>.mjs`).
    const out = execFileSync(process.execPath, [path.join(outDir, "probe.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({
      root: path.join(ROOT, "uploads"),
      magic: "BVF1",
    });
  });

  it("leaves @prisma/client external instead of bundling it", async () => {
    fs.writeFileSync(
      path.join(entryDir, "prisma-probe.ts"),
      ['import { PrismaClient } from "@prisma/client";', "console.log(typeof PrismaClient);"].join("\n"),
    );

    await buildScripts({ entryDir, outDir });
    const bundle = fs.readFileSync(path.join(outDir, "prisma-probe.mjs"), "utf8");
    // Externalized packages are re-emitted as a native ESM import, never
    // inlined — this is what lets the runner image supply its OWN
    // node_modules/@prisma at run time (Dockerfile) instead of whatever the
    // builder stage happened to have.
    expect(bundle).toMatch(/from\s*"@prisma\/client"/);
    expect(bundle).not.toContain("class PrismaClient");

    // outDir sits under this repo's dist/ (see beforeEach), so Node's ESM
    // resolver finds this repo's own node_modules/@prisma/client walking up
    // from the bundle's own location — the same shape as the real
    // dist/scripts/*.mjs under /app in the runner image. That image's own
    // node_modules/@prisma, copied in separately by the Dockerfile, is
    // proven to resolve there (as uid 1001) by the Docker check in the task
    // report, not by this unit test.
    const out = execFileSync(process.execPath, [path.join(outDir, "prisma-probe.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(out.trim()).toBe("function");
  });

  it("builds multiple entries independently, named after their entry file", async () => {
    fs.writeFileSync(path.join(entryDir, "a.ts"), 'console.log("a");');
    fs.writeFileSync(path.join(entryDir, "b.ts"), 'console.log("b");');

    const built = await buildScripts({ entryDir, outDir });
    expect(built.sort()).toEqual([path.join(outDir, "a.mjs"), path.join(outDir, "b.mjs")]);
    expect(execFileSync(process.execPath, [path.join(outDir, "a.mjs")], { encoding: "utf8" }).trim()).toBe("a");
    expect(execFileSync(process.execPath, [path.join(outDir, "b.mjs")], { encoding: "utf8" }).trim()).toBe("b");
  });
});
