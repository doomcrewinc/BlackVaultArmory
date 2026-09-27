import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { attachServerErrorHandler, createDirectAccessTracker, createGate, createRejectedPeerLog } from "./gate-server.mjs";

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

  it("bounds the rejected-peer log via the now/rejectedLogSize seam: stale entries are swept", async () => {
    const upstreamPort = await echoUpstream();
    let now = 0;
    const gate = createGate({
      upstreamPort,
      isTrusted: () => false,
      getDirectAccess: () => false,
      trustLoopback: false,
      log: quiet,
      now: () => now,
    });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);

    await connectAndWait(port);
    expect(gate.rejectedLogSize()).toBe(1);

    now += 60_000; // advance past LOG_INTERVAL_MS
    await connectAndWait(port);
    // The stale entry for 127.0.0.1 was swept before being re-recorded, so
    // the map does not accumulate a second entry for the same peer.
    expect(gate.rejectedLogSize()).toBe(1);
  });

  it("attaches an error listener to a rejected socket before resetAndDestroy, so an async error from the underlying handle.reset() does not crash the process", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => false, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);

    // Simulate what Node does when resetAndDestroy's underlying
    // handle.reset() call reports an error: the socket is still torn down,
    // but an 'error' is also emitted (asynchronously, after resetAndDestroy
    // returns). Without a listener already attached, that emit throws
    // inside Node's EventEmitter and becomes an uncaughtException.
    const original = net.Socket.prototype.resetAndDestroy;
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    net.Socket.prototype.resetAndDestroy = function (this: net.Socket, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      queueMicrotask(() => this.emit("error", Object.assign(new Error("simulated handle.reset failure"), { code: "ECONNRESET" })));
      return result;
    } as typeof net.Socket.prototype.resetAndDestroy;

    try {
      const result = await connectAndWait(port);
      expect(result).toEqual({ error: "ECONNRESET" });
      await new Promise((r) => setImmediate(r)); // let the simulated microtask emit run
    } finally {
      net.Socket.prototype.resetAndDestroy = original;
      process.off("uncaughtException", onUncaught);
    }
    expect(uncaught).toEqual([]);
  });
});

describe("createRejectedPeerLog", () => {
  it("evicts entries older than the interval, so size stays bounded across many distinct keys", () => {
    let now = 0;
    const rejectedLog = createRejectedPeerLog(() => now, 60_000);
    for (let i = 0; i < 500; i++) rejectedLog.shouldLog(`peer-${i}`);
    expect(rejectedLog.size()).toBe(500);

    now += 60_000; // advance past the interval: all 500 are now stale
    rejectedLog.shouldLog("peer-new");
    // Every stale entry was swept on this call; only the newly-logged key remains.
    expect(rejectedLog.size()).toBe(1);
  });

  it("still suppresses repeat logging of the same key within the interval", () => {
    let now = 0;
    const rejectedLog = createRejectedPeerLog(() => now, 60_000);
    expect(rejectedLog.shouldLog("1.2.3.4")).toBe(true);
    now += 30_000;
    expect(rejectedLog.shouldLog("1.2.3.4")).toBe(false);
    now += 30_000;
    expect(rejectedLog.shouldLog("1.2.3.4")).toBe(true);
  });
});

describe("attachServerErrorHandler", () => {
  it("logs and exits when the error happens before 'listening' has fired", () => {
    const server = new EventEmitter();
    const errors: string[] = [];
    const exits: number[] = [];
    attachServerErrorHandler(server as unknown as import("node:net").Server, {
      log: { ...quiet, error: (m: string) => errors.push(m) },
      exit: (code?: number) => exits.push(code ?? 0),
    });
    server.emit("error", Object.assign(new Error("boom"), { code: "EADDRINUSE" }));
    expect(exits).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("logs and continues when the error happens after 'listening' has fired", () => {
    const server = new EventEmitter();
    const errors: string[] = [];
    const exits: number[] = [];
    attachServerErrorHandler(server as unknown as import("node:net").Server, {
      log: { ...quiet, error: (m: string) => errors.push(m) },
      exit: (code?: number) => exits.push(code ?? 0),
    });
    server.emit("listening");
    server.emit("error", Object.assign(new Error("boom"), { code: "EMFILE" }));
    expect(exits).toEqual([]);
    expect(errors).toHaveLength(1);
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
