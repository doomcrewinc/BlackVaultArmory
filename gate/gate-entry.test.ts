/**
 * gate/gate.mjs, run for real: it owns the public port, then overrides
 * PORT to 3001 process-wide so Next's standalone server binds the upstream.
 * Anything in the app that reports a user-facing URL must see the gate's
 * public port, not 3001 (container-internal, never published). The gate
 * records it as GATE_PORT before the override; this checks that it does.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const GATE = path.join(__dirname, "gate.mjs");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

describe("gate.mjs startup", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-gate-entry-"));
    // Stands in for Next's standalone server.js: report what it was given,
    // then end the process (and with it the gate).
    fs.writeFileSync(
      path.join(dir, "server.js"),
      `console.log("ENV=" + JSON.stringify({ PORT: process.env.PORT, GATE_PORT: process.env.GATE_PORT, HOSTNAME: process.env.HOSTNAME }));\nprocess.exit(0);\n`,
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("records its public port as GATE_PORT before handing PORT=3001 to Next", async () => {
    const port = await freePort();
    const env0: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), TRUSTED_PROXIES: "" };
    delete env0.GATE_PORT;
    const r = spawnSync(process.execPath, [GATE], {
      cwd: dir,
      encoding: "utf8",
      env: env0,
      timeout: 15000,
    });
    const line = r.stdout.split("\n").find((l) => l.startsWith("ENV="));
    expect(line, `stdout: ${r.stdout}\nstderr: ${r.stderr}`).toBeDefined();
    const env = JSON.parse(line!.slice(4));
    expect(env).toEqual({ PORT: "3001", GATE_PORT: String(port), HOSTNAME: "127.0.0.1" });
  });
});
