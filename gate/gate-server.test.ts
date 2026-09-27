import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectAccessTracker, createGate } from "./gate-server.mjs";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

async function echoUpstream(): Promise<number> {
  const upstream = net.createServer((s) => s.pipe(s));
  closers.push(() => upstream.close());
  return listen(upstream);
}

function outcome(port: number, payload = "ping"): Promise<{ data?: string; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    socket.once("data", (d) => {
      resolve({ data: d.toString() });
      socket.destroy();
    });
    socket.once("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code }));
  });
}

// Connects and writes NOTHING. This is deliberate: if the client writes
// first (as `outcome` above does), a plain `destroy()` on a socket with
// unread received data still makes the kernel send an RST, so ECONNRESET
// shows up whether the gate called `destroy()` or `resetAndDestroy()` — the
// two are indistinguishable and a destroy()-for-resetAndDestroy() regression
// would not fail this test. With nothing written, there is no unread data:
// `destroy()` produces a clean close (`{ closed: true }`), and only
// `resetAndDestroy()` still forces ECONNRESET. Used for the rejection-path
// tests, where the assertion must tell a reset apart from a plain close.
function connectAndWait(port: number): Promise<{ error?: string; closed?: boolean }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code }));
    socket.once("close", (hadError) => {
      if (!hadError) resolve({ closed: true });
    });
  });
}

const quiet = { warn() {}, error() {}, log() {} };

describe("createGate", () => {
  it("resets an untrusted peer with ECONNRESET when direct access is off", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => false, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await connectAndWait(await listen(gate.server))).toEqual({ error: "ECONNRESET" });
  });

  it("pipes a trusted peer to upstream", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => true, getDirectAccess: () => false, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("pipes loopback by default (the healthcheck)", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("pipes an untrusted peer when direct access is on", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => true, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("resets open untrusted connections when direct access turns off", async () => {
    const upstreamPort = await echoUpstream();
    let direct = true;
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => direct, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);

    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.write("hello");
    await new Promise((r) => socket.once("data", r));
    // No further writes after the echo: by the time `data` fires, the
    // round trip has drained the gate-side socket's receive buffer (the
    // gate piped the bytes through and got the echo back), so there is no
    // unread data left when dropUntrusted() runs below. A plain `destroy()`
    // there would close cleanly with no error and this test would hang/fail
    // instead of a `resetAndDestroy()` producing ECONNRESET — verified with
    // a standalone script (fix-round-1-injection-proof.mjs, scenario C):
    // destroy() -> { closed: true }, resetAndDestroy() -> ECONNRESET, 3/3 runs.

    const closed = new Promise<string | undefined>((resolve) =>
      socket.once("error", (e: NodeJS.ErrnoException) => resolve(e.code)),
    );
    direct = false;
    gate.dropUntrusted();
    expect(await closed).toBe("ECONNRESET");
  });

  it("logs a rejected peer once per minute, not per connection", async () => {
    const upstreamPort = await echoUpstream();
    const warnings: string[] = [];
    const gate = createGate({
      upstreamPort,
      isTrusted: () => false,
      getDirectAccess: () => false,
      trustLoopback: false,
      log: { ...quiet, warn: (m: string) => warnings.push(m) },
    });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);
    await connectAndWait(port);
    await connectAndWait(port);
    expect(warnings).toEqual(["[gate] rejected 127.0.0.1 (not a trusted proxy; direct access off)"]);
  });
});

describe("createDirectAccessTracker", () => {
  it("fires onTurnedOff only on a true -> false transition", () => {
    let fired = 0;
    const t = createDirectAccessTracker(false, () => fired++);
    t.set(false);
    t.set(true);
    t.set(true);
    t.set(false);
    t.set(false);
    expect(fired).toBe(1);
    expect(t.get()).toBe(false);
  });
});
