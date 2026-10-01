import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";

// Vite's own module resolution (the `import()` Vitest transforms source
// through) cannot resolve the generated `.prisma/client-sqlite` package the
// way plain Node `require` can — the same reason src/lib/prisma.ts itself
// reaches it with `require(".prisma/client-sqlite")` rather than `import`.
const nodeRequire = createRequire(import.meta.url);

/**
 * Review C1 (critical): Next 16's proxy (src/proxy.ts has no matcher, so it
 * runs on every request) clones the request body and TRUNCATES it at
 * `experimental.proxyClientMaxBodySize` — default 10 MB
 * (node_modules/next/dist/server/config-shared.js) — before the route
 * handler ever sees it. A sealed backup envelope is plaintext size + ~33%
 * (base64), so a real inventory comfortably exceeds 10 MB, and the failure
 * mode was a misleading "Invalid JSON body" rather than a clear body-size
 * error. next.config.ts now sets `proxyClientMaxBodySize: "256mb"`.
 *
 * This is the ONE test in the suite that calls the handler through a REAL
 * Next.js server process (the standalone production build, started the same
 * way `Dockerfile`'s CMD does — `node .next/standalone/server.js`, not
 * `next start`, which this repo's `output: "standalone"` config doesn't
 * support — see the warning `next start` itself prints). Every other
 * route-level test in this suite (route.test.ts, route.sealed.roundtrip.test.ts,
 * etc.) calls the Next.js route handler FUNCTION directly, in-process, which
 * never goes through src/proxy.ts and therefore cannot prove anything about
 * this limit — that was exactly the gap the review found in the original
 * Task 5 report's 50 MB test (restore/route.test.ts's
 * "accepts a ~50 MB sealed-envelope body..." test), which calls `POST(request)`
 * directly and so never exercises the proxy's body-size cap at all.
 *
 * Cost: this test runs `npm run build` once (reusing the project's normal
 * production build — the same one CI and `docker build` produce) and seeds
 * 25,000 firearms directly against a scratch SQLite file, so it is slow
 * (observed: low tens of seconds) and does real filesystem/network I/O. That
 * cost buys the one claim no other test here can make: a ≥40 MB sealed
 * backup restores correctly THROUGH THE PROXY, not just through the handler.
 *
 * Never touches prisma/prisma/dev.db: DATABASE_URL always points at a
 * throw-away file under TMPDIR, deleted in afterAll. The server is started
 * with spawn() and killed by its own PID in afterAll — never pkill/killall.
 */

const ctx = {
  dir: `${(process.env.TMPDIR || "/tmp").replace(/\/+$/, "")}/bv-c1-proxy-body-size-${process.pid}-${Date.now()}`,
  get dbFile() {
    return `${this.dir}/c1.db`;
  },
  port: 0,
  server: null as ChildProcess | null,
  cookie: "",
};

/** Binds to port 0 to let the OS choose a free port, then releases it immediately. Small TOCTOU race, acceptable for a test. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, () => {
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
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

describe("C1 (review, critical): a ≥40 MB sealed backup restores through the REAL server's proxy", () => {
  let key = "";

  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });

    // 1. Migrate the scratch SQLite file.
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${ctx.dbFile}` },
      stdio: "pipe",
    });

    // 2. Build the real production app (same build the Dockerfile ships),
    //    so next.config.ts's proxyClientMaxBodySize is the one actually in
    //    effect — this is a config-load-time setting, not something a
    //    directly-called route handler can prove either way.
    execFileSync("npm", ["run", "build"], {
      cwd: process.cwd(),
      // No encryption key needed to build — only to serve.
      env: { ...process.env, BLACKVAULT_ENCRYPTION_KEY: undefined, BLACKVAULT_ENCRYPTION_KEY_FILE: undefined } as unknown as NodeJS.ProcessEnv,
      stdio: "pipe",
      timeout: 240_000,
    });

    // 3. The standalone server needs its static assets copied alongside it —
    //    exactly what Dockerfile's `COPY --from=builder .next/static` /
    //    `COPY --from=builder public` steps do; `next start` itself warns
    //    this repo's `output: "standalone"` build doesn't work without it.
    execFileSync("sh", ["-c", "mkdir -p .next/standalone/.next/static && cp -r .next/static/. .next/standalone/.next/static/ && mkdir -p .next/standalone/public && cp -r public/. .next/standalone/public/ 2>/dev/null; true"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    ctx.port = await freePort();
    key = "c1".repeat(32); // 64 hex chars — any valid key; this DB is new.

    ctx.server = spawn(
      "node",
      [".next/standalone/server.js"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          VAULT_ENCRYPTION_KEY: undefined,
          DB_PROVIDER: "sqlite",
          DATABASE_URL: `file:${ctx.dbFile}`,
          BLACKVAULT_ENCRYPTION_KEY: key,
          BLACKVAULT_ENCRYPTION_KEY_FILE: "/nonexistent/no-key-file",
          PUBLIC_URL: `http://localhost:${ctx.port}`,
          PORT: String(ctx.port),
          HOSTNAME: "0.0.0.0",
          NODE_ENV: "production",
        } as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

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

    const setupRes = await fetch(`http://localhost:${ctx.port}/api/auth/setup`, {
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

    // 4. Seed enough firearms to push a sealed backup past 40 MB. Written
    //    directly with core.mjs (the same module the app's own encryption
    //    extension uses) so the rows are real bv2: ciphertext with a real
    //    fingerprint — the app (strict reads) would otherwise throw
    //    PLAINTEXT_AT_REST reading them back for the backup.
    const { PrismaClient } = nodeRequire(".prisma/client-sqlite");
    const core = await import("@/lib/encryption/core.mjs");
    const raw = new PrismaClient({ datasources: { db: { url: `file:${ctx.dbFile}` } } });
    const keys = core.deriveKeys(core.parseKeyHex(key));
    const note = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8);
    const N = 25_000;
    try {
      for (let i = 0; i < N; i += 1000) {
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
  });

  it("restores a ≥40 MB sealed envelope sent through the real server, not just the handler", async () => {
    const passphrase = "correct horse battery staple c1 test";

    const backupRes = await fetch(`http://localhost:${ctx.port}/api/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: ctx.cookie },
      body: JSON.stringify({ passphrase }),
    });
    expect(backupRes.status).toBe(200);
    const envelopeText = await backupRes.text();
    const envelope = JSON.parse(envelopeText);
    expect(envelope.format).toBe("blackvault-sealed-backup");

    const restoreBody = JSON.stringify({ sealed: envelope, passphrase });
    expect(restoreBody.length, "the request body must actually be ≥40 MB for this test to mean anything").toBeGreaterThan(
      40 * 1024 * 1024,
    );

    const restoreRes = await fetch(`http://localhost:${ctx.port}/api/backup/restore`, {
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
    expect(restoreJson.counts.firearms).toBe(25_000);

    const statsRes = await fetch(`http://localhost:${ctx.port}/api/stats`, { headers: { Cookie: ctx.cookie } });
    const stats = await statsRes.json();
    expect(stats.totals.firearms).toBe(25_000);
  }, 300_000);
});
