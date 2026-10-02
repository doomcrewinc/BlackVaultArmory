import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";

// Vite's own module resolution (the `import()` Vitest transforms source
// through) cannot resolve the generated `.prisma/client-sqlite` package the
// way plain Node `require` can — the same reason src/lib/prisma.ts itself
// reaches it with `require(".prisma/client-sqlite")` rather than `import`.
const nodeRequire = createRequire(import.meta.url);
// The exact parser Next uses to normalise proxyClientMaxBodySize (as next.config.test.ts does).
const bytes = nodeRequire("next/dist/compiled/bytes") as { parse(v: string | number): number | null };

/**
 * Review C1 (critical): Next 16's proxy (src/proxy.ts has no matcher, so it
 * runs on every request) clones the request body and TRUNCATES it at
 * `experimental.proxyClientMaxBodySize` — default 10 MB
 * (node_modules/next/dist/server/config-shared.js) — before the route
 * handler ever sees it. A sealed backup envelope is plaintext size + ~33%
 * (base64), so a real inventory comfortably exceeds 10 MB, and the failure
 * mode was a misleading "Invalid JSON body" rather than a clear body-size
 * error. next.config.ts now sets `proxyClientMaxBodySize: "64mb"` (lowered
 * from an earlier 256 MB after review round 2 found the 256 MB cap itself
 * was an unauthenticated memory-DoS vector — see next.config.ts's comment —
 * and `next.config.test.ts`, which always runs, asserts the parsed value).
 *
 * This is the ONE test in the suite that calls the handler through a REAL
 * Next.js server process (the standalone production build, started the same
 * way `Dockerfile`'s CMD does — `node .next/standalone/server.js`, not
 * `next start`, which this repo's `output: "standalone"` config doesn't
 * support — see the warning `next start` itself prints). Every other
 * route-level test in this suite (route.test.ts, route.sealed.roundtrip.test.ts,
 * etc.) calls the Next.js route handler FUNCTION directly, in-process, which
 * never goes through src/proxy.ts and therefore cannot prove anything about
 * this limit.
 *
 * GATED (review round 2): off by default — `describe.skipIf`, not a bare
 * `it.skip`, so `beforeAll`'s build/seed cost is skipped too, not just the
 * assertion. Opt in with `RUN_SERVER_TESTS=1`. Reasons it is not part of the
 * default `npm test`:
 * - it builds the real app and starts a real server process, which the rest
 *   of the suite never does;
 * - round 1's version called `npm run build` unconditionally, which
 *   regenerates BOTH Prisma clients and the Prisma schemas mid-run
 *   (package.json's `build` script runs `gen:schemas && db:generate && …`) —
 *   a global `node_modules/.prisma/*` mutation that any OTHER test worker
 *   reading those files at the same moment would see change under it. This
 *   version instead reuses `.next/standalone/server.js` when it already
 *   exists (true in CI, right after the normal build step) and otherwise
 *   runs `next build` directly — never the `npm run build` script, never a
 *   schema/client regeneration.
 *
 * CI runs it explicitly: `.github/workflows/ci.yml`'s `verify` job runs this
 * file with `RUN_SERVER_TESTS=1` immediately after its own `npm run build`
 * step, so the build is already current and this test's own build check is
 * a no-op there.
 *
 * Never touches prisma/prisma/dev.db: DATABASE_URL always points at a
 * throw-away file under TMPDIR, deleted in afterAll. The server is started
 * with spawn() and killed by its own PID — in afterAll on a normal run, and
 * via process-level `exit`/`SIGTERM` handlers (review round 2) so a server
 * started by this test is never orphaned if the test runner itself is
 * killed mid-run (e.g. `kill` sent to the vitest process) — never
 * pkill/killall. Binds to 127.0.0.1, not 0.0.0.0: this is a throw-away
 * single-test server with a throw-away admin password, and there is no
 * reason for it to be reachable from the network.
 */

/** ~40 MB sealed, comfortably under the 64 MB cap (review round 2). */
const N_FIREARMS = 22_000;

const ctx = {
  dir: `${(process.env.TMPDIR || "/tmp").replace(/\/+$/, "")}/bv-c1-proxy-body-size-${process.pid}-${Date.now()}`,
  get dbFile() {
    return `${this.dir}/c1.db`;
  },
  port: 0,
  server: null as ChildProcess | null,
  cookie: "",
};

/**
 * Review round 2: kill this test's OWN spawned server (nothing else — PID
 * only, never pkill/killall) if the test process itself exits or is sent
 * SIGTERM, not only on a normal `afterAll` completion. `exit` handlers may
 * only do synchronous work, so this is a plain signal send, not the
 * graceful SIGTERM-then-wait-then-SIGKILL `afterAll` does below. Registered
 * once at module scope — this file's only `describe` either way.
 */
function killOrphanServer() {
  if (ctx.server && ctx.server.pid) {
    try {
      ctx.server.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  try {
    rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // best-effort: the process may not have released the SQLite file yet
  }
}
process.on("exit", killOrphanServer);
process.on("SIGTERM", () => {
  killOrphanServer();
  process.exit(143); // 128 + SIGTERM(15), the conventional exit code
});

/** Binds to port 0 to let the OS choose a free port, then releases it immediately. Small TOCTOU race, acceptable for a test. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

/** Dockerfile's `COPY --from=builder .next/static` / `COPY --from=builder public` steps, replicated locally — `next start` itself warns this repo's `output: "standalone"` build doesn't work without them. Idempotent; cheap to re-run even when the build itself was reused. */
function copyStandaloneAssets() {
  execFileSync(
    "sh",
    [
      "-c",
      "mkdir -p .next/standalone/.next/static && cp -r .next/static/. .next/standalone/.next/static/ && mkdir -p .next/standalone/public && cp -r public/. .next/standalone/public/ 2>/dev/null; true",
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
}

/**
 * Final review FIX 13: reuse `.next/standalone` ONLY when it was built with
 * the cap next.config.ts sets now. A stale build (proven in the Task 5
 * review: one still had the 256 MB value baked in) would let this test pass
 * or fail for the wrong config. `next build` records the parsed value in
 * `.next/required-server-files.json` (`config.experimental.proxyClientMaxBodySize`,
 * in bytes); `configured` is next.config.ts's raw value ("64mb").
 */
function reusableStandaloneBuild(root: string, configured: unknown): boolean {
  if (!existsSync(`${root}/.next/standalone/server.js`)) return false;
  let built: unknown;
  try {
    built = JSON.parse(readFileSync(`${root}/.next/required-server-files.json`, "utf8"))?.config?.experimental
      ?.proxyClientMaxBodySize;
  } catch {
    return false;
  }
  const norm = (v: unknown) => (typeof v === "string" || typeof v === "number" ? bytes.parse(v) : null);
  const want = norm(configured);
  return typeof want === "number" && norm(built) === want;
}

describe("reusableStandaloneBuild (final review FIX 13; always runs)", () => {
  function fakeBuild(cap: unknown, withServer = true): string {
    const root = mkdtempSync(`${tmpdir()}/bv-c1-build-`);
    mkdirSync(`${root}/.next/standalone`, { recursive: true });
    if (withServer) writeFileSync(`${root}/.next/standalone/server.js`, "");
    writeFileSync(`${root}/.next/required-server-files.json`, JSON.stringify({ config: { experimental: { proxyClientMaxBodySize: cap } } }));
    return root;
  }
  it("reuses a build whose recorded cap equals next.config.ts's", () => {
    const root = fakeBuild(64 * 1024 * 1024);
    expect(reusableStandaloneBuild(root, "64mb")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
  it("rebuilds when the recorded cap differs (a stale 256 MB build), is missing, or there is no server.js", () => {
    for (const root of [fakeBuild(256 * 1024 * 1024), fakeBuild(undefined), fakeBuild(64 * 1024 * 1024, false)]) {
      expect(reusableStandaloneBuild(root, "64mb")).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }
    const noManifest = mkdtempSync(`${tmpdir()}/bv-c1-build-`);
    mkdirSync(`${noManifest}/.next/standalone`, { recursive: true });
    writeFileSync(`${noManifest}/.next/standalone/server.js`, "");
    expect(reusableStandaloneBuild(noManifest, "64mb")).toBe(false);
    rmSync(noManifest, { recursive: true, force: true });
  });
});

describe.skipIf(!process.env.RUN_SERVER_TESTS)(
  "C1 (review, critical): a sealed backup under the 64 MB cap restores through the REAL server's proxy",
  () => {
    let key = "";

    beforeAll(async () => {
      mkdirSync(ctx.dir, { recursive: true });

      // 1. Migrate the scratch SQLite file — always, regardless of whether
      //    the app build below is reused.
      execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
        cwd: process.cwd(),
        env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${ctx.dbFile}` },
        stdio: "pipe",
      });

      // 2. Reuse the existing production build when there is one (true in
      //    CI, right after its own `npm run build` step — see this file's
      //    docblock). Otherwise build directly with `next build`, NOT
      //    `npm run build`: the npm script also runs `gen:schemas` and
      //    `db:generate`, regenerating both Prisma clients and schemas —
      //    global `node_modules`/`prisma/*` state any other test worker
      //    could be reading at the same moment (review round 2).
      // FIX 13: …and only when that build has next.config.ts's current cap.
      const { default: nextConfig } = await import("../../../../../next.config");
      if (!reusableStandaloneBuild(process.cwd(), nextConfig.experimental?.proxyClientMaxBodySize)) {
        execFileSync("npx", ["next", "build"], {
          cwd: process.cwd(),
          // No encryption key or database needed to build.
          env: { ...process.env, BLACKVAULT_ENCRYPTION_KEY: undefined, BLACKVAULT_ENCRYPTION_KEY_FILE: undefined } as unknown as NodeJS.ProcessEnv,
          stdio: "pipe",
          timeout: 240_000,
        });
      }
      copyStandaloneAssets();

      ctx.port = await freePort();
      key = "c1".repeat(32); // 64 hex chars — any valid key; this DB is new.

      ctx.server = spawn("node", [".next/standalone/server.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VAULT_ENCRYPTION_KEY: undefined,
          DB_PROVIDER: "sqlite",
          DATABASE_URL: `file:${ctx.dbFile}`,
          BLACKVAULT_ENCRYPTION_KEY: key,
          BLACKVAULT_ENCRYPTION_KEY_FILE: "/nonexistent/no-key-file",
          PUBLIC_URL: `http://127.0.0.1:${ctx.port}`,
          PORT: String(ctx.port),
          HOSTNAME: "127.0.0.1",
          NODE_ENV: "production",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let setupCode = "";
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const m = /Setup token: (\S+)/.exec(text);
        if (m) setupCode = m[1];
      };
      ctx.server.stdout?.on("data", onData);
      ctx.server.stderr?.on("data", onData);

      await waitForHealth(ctx.port, 30_000);
      // The setup-token line is printed once at startup; give it a moment if
      // health answered before stdout was flushed.
      for (let i = 0; i < 40 && !setupCode; i++) await new Promise((r) => setTimeout(r, 100));
      if (!setupCode) throw new Error("Did not see a setup token in the server's output");

      const setupRes = await fetch(`http://127.0.0.1:${ctx.port}/api/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          setupCode,
          username: "admin",
          displayName: "Admin",
          password: "c1-real-server-test-password",
        }),
      });
      if (!setupRes.ok) throw new Error(`Setup failed: ${setupRes.status} ${await setupRes.text()}`);
      const setCookie = setupRes.headers.get("set-cookie") ?? "";
      const cookieMatch = /^[^;]+/.exec(setCookie);
      if (!cookieMatch) throw new Error(`No session cookie in setup response: ${setCookie}`);
      ctx.cookie = cookieMatch[0];

      // 3. Seed enough firearms to push a sealed backup to roughly 40 MB —
      //    comfortably past the old 10 MB default, comfortably under the
      //    64 MB cap. Written directly with core.mjs (the same module the
      //    app's own encryption extension uses) so the rows are real bv2:
      //    ciphertext with a real fingerprint — the app (strict reads)
      //    would otherwise throw PLAINTEXT_AT_REST reading them back for
      //    the backup.
      const { PrismaClient } = nodeRequire(".prisma/client-sqlite");
      const core = await import("@/lib/encryption/core.mjs");
      const raw = new PrismaClient({ datasources: { db: { url: `file:${ctx.dbFile}` } } });
      const keys = core.deriveKeys(core.parseKeyHex(key));
      const note = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);
      try {
        for (let i = 0; i < N_FIREARMS; i += 1000) {
          await raw.firearm.createMany({
            data: Array.from({ length: 1000 }, (_, k) => {
              const idx = i + k;
              const serial = `BIG-SER-${idx}`;
              return {
                id: `big-${idx}`,
                name: `Firearm ${idx}`,
                manufacturer: "Acme",
                model: "Big",
                caliber: "9mm",
                type: "PISTOL",
                serialNumber: core.encryptValue(keys, "Firearm.serialNumber", serial),
                serialNumberHash: core.fingerprint(keys, serial),
                notes: note,
                acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
              };
            }),
          });
        }
      } finally {
        await raw.$disconnect();
      }
    }, 300_000);

    afterAll(async () => {
      if (ctx.server && ctx.server.pid) {
        ctx.server.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
        // Never pkill/killall — only this one PID this test itself started.
        try {
          process.kill(ctx.server.pid, 0); // still alive?
          ctx.server.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
      rmSync(ctx.dir, { recursive: true, force: true });
      process.off("exit", killOrphanServer);
    });

    it("restores a ~40 MB sealed envelope — under the 64 MB cap — sent through the real server, not just the handler", async () => {
      const passphrase = "correct horse battery staple c1 test";

      const backupRes = await fetch(`http://127.0.0.1:${ctx.port}/api/backup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
        body: JSON.stringify({ passphrase }),
      });
      expect(backupRes.status).toBe(200);
      const envelopeText = await backupRes.text();
      const envelope = JSON.parse(envelopeText);
      expect(envelope.format).toBe("blackvault-sealed-backup");

      const restoreBody = JSON.stringify({ sealed: envelope, passphrase });
      // Large enough that the OLD 10 MB default would have truncated it, and
      // comfortably under the 64 MB cap this backup/restore flow now has to
      // fit under.
      expect(restoreBody.length).toBeGreaterThan(30 * 1024 * 1024);
      expect(restoreBody.length).toBeLessThan(64 * 1024 * 1024);

      const restoreRes = await fetch(`http://127.0.0.1:${ctx.port}/api/backup/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
        body: restoreBody,
      });
      const restoreJson = await restoreRes.json();

      // The OLD behaviour (proven by the review, and manually reproduced
      // before this fix): the proxy truncates the body at 10 MB and the route
      // handler then sees invalid JSON — `400 { error: "Invalid JSON body" }`,
      // logged server-side as "Request body exceeded 10MB for
      // /api/backup/restore". With proxyClientMaxBodySize raised, the full
      // body arrives and the restore succeeds.
      expect(restoreRes.status, JSON.stringify(restoreJson)).toBe(200);
      expect(restoreJson.success).toBe(true);
      expect(restoreJson.counts.firearms).toBe(N_FIREARMS);

      const statsRes = await fetch(`http://127.0.0.1:${ctx.port}/api/stats`, { headers: { Cookie: ctx.cookie } });
      const stats = await statsRes.json();
      expect(stats.totals.firearms).toBe(N_FIREARMS);
    }, 300_000);
  },
);
