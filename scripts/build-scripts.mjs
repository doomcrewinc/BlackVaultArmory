#!/usr/bin/env node
// Bundles every scripts/entry/<name>.ts into dist/scripts/<name>.mjs with
// esbuild, for the CLI engines (full-backup, full-restore, reencrypt-files —
// spec docs/superpowers/specs/2026-10-02-full-backups-design.md) that run
// inside the app container as `node dist/scripts/<name>.mjs`. This file
// adds no entry of its own (ruling R1): later tasks only add files under
// scripts/entry/, and with none present the build succeeds, building
// nothing.
//
// `@prisma/client` and `.prisma/*` stay external: the runner image already
// ships both under node_modules/.prisma and node_modules/@prisma
// (Dockerfile), generated for the SAME platform the image runs on, and must
// be resolved there at runtime — bundling the builder stage's copies in
// would freeze a possibly different native build inside the ESM output.
//
// entryDir/outDir are function parameters (not hardcoded) precisely so a
// test can point this at a temp directory holding one throwaway probe
// entry; no probe is ever committed under scripts/entry/.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const DEFAULT_ENTRY_DIR = path.join(SCRIPTS_DIR, "entry");
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, "dist", "scripts");
const TSCONFIG = path.join(REPO_ROOT, "tsconfig.json");

/**
 * Bundles every `*.ts` file directly inside `entryDir` into `<outDir>/<name>.mjs`.
 * Returns the list of output file paths written (empty when entryDir has no
 * entries, or does not exist at all — both are success, not an error).
 *
 * @param {{ entryDir?: string; outDir?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function buildScripts({ entryDir = DEFAULT_ENTRY_DIR, outDir = DEFAULT_OUT_DIR } = {}) {
  // Created unconditionally, even with no entryDir at all: the Dockerfile's
  // builder stage always runs this, and the runner stage always
  // `COPY --from=builder /app/dist/scripts ./dist/scripts` — that COPY needs
  // a real directory to exist, even an empty one.
  fs.mkdirSync(outDir, { recursive: true });

  let names;
  try {
    names = fs.readdirSync(entryDir).filter((f) => f.endsWith(".ts"));
  } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  if (names.length === 0) return [];

  const built = [];
  for (const file of names.sort()) {
    const name = file.slice(0, -3); // strip ".ts"
    const outfile = path.join(outDir, `${name}.mjs`);
    await build({
      entryPoints: [path.join(entryDir, file)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      // Resolves the "@/*" -> "./src/*" alias (tsconfig.json's `paths`)
      // against THIS repo's tsconfig regardless of where entryDir lives,
      // which is what lets a test build a probe from a temp directory.
      tsconfig: TSCONFIG,
      external: ["@prisma/client", ".prisma/*"],
      // src/lib/prisma.ts loads the client with require(".prisma/client-sqlite")
      // / require("@prisma/client"). In an ESM bundle esbuild turns those into
      // its __require shim, which throws "Dynamic require ... is not
      // supported" unless a real `require` is in scope. The banner provides
      // one. The import alias is namespaced (__bvCreateRequire) so it cannot
      // collide with a name the bundle declares; `require` itself must keep
      // that exact name because the shim looks it up via `typeof require`
      // (esbuild never emits a top-level declaration called `require`).
      banner: {
        js: 'import { createRequire as __bvCreateRequire } from "node:module"; const require = __bvCreateRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
    built.push(outfile);
  }
  return built;
}

function isDirectRun() {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  buildScripts()
    .then((built) => {
      if (built.length === 0) {
        console.log("build-scripts: no entry files under scripts/entry/ — nothing to build.");
        return;
      }
      for (const f of built) console.log(`build-scripts: built ${path.relative(REPO_ROOT, f)}`);
    })
    .catch((e) => {
      console.error(e && e.stack ? e.stack : String(e));
      process.exitCode = 1;
    });
}
