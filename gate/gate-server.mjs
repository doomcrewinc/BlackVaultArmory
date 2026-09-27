// The TCP gate: decides whether a connection may exist, before any HTTP is
// read. Untrusted peers are reset (the client sees ECONNRESET) when direct
// access is off. Everything else is piped byte-for-byte to Next.
import net from "node:net";
import { isLoopback, normalizePeer } from "./gate-core.mjs";

const LOG_INTERVAL_MS = 60_000;

/**
 * @typedef {{ warn: (...args: any[]) => void, error: (...args: any[]) => void, log: (...args: any[]) => void }} GateLogger
 */

/**
 * Tracks the last time each peer key was logged as rejected, so callers can
 * log once per `intervalMs` per key instead of once per connection.
 *
 * On a public port facing scanners or many distinct (especially IPv6)
 * sources, a map keyed only by peer and never pruned grows for as long as
 * the process runs — one entry per distinct peer ever seen, forever. Every
 * call sweeps entries whose last-logged time is at least `intervalMs` in the
 * past, so the map's size is bounded by the number of distinct peers
 * rejected within the last interval, not by how many distinct peers have
 * ever connected.
 *
 * @param {() => number} [now]
 * @param {number} [intervalMs]
 */
export function createRejectedPeerLog(now = Date.now, intervalMs = LOG_INTERVAL_MS) {
  const lastLogged = new Map();
  return {
    /** @param {string} key @returns {boolean} whether the caller should log now */
    shouldLog(key) {
      const ts = now();
      for (const [k, t] of lastLogged) {
        if (ts - t >= intervalMs) lastLogged.delete(k);
      }
      if (ts - (lastLogged.get(key) ?? -Infinity) < intervalMs) return false;
      lastLogged.set(key, ts);
      return true;
    },
    size() {
      return lastLogged.size;
    },
  };
}

/**
 * Wires a server's 'error' event so a listen-time failure (EADDRINUSE,
 * EACCES — i.e. before 'listening' has fired) logs and exits the process
 * fast, while an accept-time failure under load (EMFILE, ENFILE — after
 * 'listening' has fired) just logs and lets the server keep running.
 *
 * @param {import("node:net").Server} server
 * @param {{ log?: GateLogger, exit?: (code?: number) => void }} [options]
 */
export function attachServerErrorHandler(server, { log = console, exit = process.exit } = {}) {
  let listening = false;
  server.once("listening", () => {
    listening = true;
  });
  server.on("error", (err) => {
    const code = err && err.code ? err.code : String(err);
    if (listening) {
      log.error(`[gate] server error: ${code}`);
    } else {
      log.error(`[gate] server failed to start (error before listening): ${code}`);
      exit(1);
    }
  });
}

/**
 * @param {{
 *   upstreamHost?: string,
 *   upstreamPort: number,
 *   isTrusted: (ip: string) => boolean,
 *   getDirectAccess: () => boolean,
 *   trustLoopback?: boolean,
 *   log?: GateLogger,
 *   now?: () => number,
 * }} options
 */
export function createGate({
  upstreamHost = "127.0.0.1",
  upstreamPort,
  isTrusted,
  getDirectAccess,
  trustLoopback = true,
  log = console,
  now = Date.now,
}) {
  const untrusted = new Set();
  const rejectedLog = createRejectedPeerLog(now, LOG_INTERVAL_MS);

  function logRejected(peer) {
    const key = peer ?? "unknown";
    if (rejectedLog.shouldLog(key)) {
      log.warn(`[gate] rejected ${key} (not a trusted proxy; direct access off)`);
    }
  }

  const server = net.createServer((client) => {
    const peer = normalizePeer(client.remoteAddress);
    const trusted = peer !== null && ((trustLoopback && isLoopback(peer)) || isTrusted(peer));

    if (!trusted && !getDirectAccess()) {
      logRejected(peer);
      // resetAndDestroy()'s underlying handle.reset() call can itself
      // report an error, which resetAndDestroy() then emits asynchronously
      // on `client`. With no listener, that is an unhandled 'error' event —
      // Node throws it as an uncaughtException, taking the whole gate (and
      // Next, since it runs in this same process) down. A no-op listener
      // makes it a logged no-op instead of a crash; it has no effect on
      // what the connecting client observes (still ECONNRESET at the TCP
      // level, decided by the kernel, not by this listener).
      client.on("error", () => {});
      client.resetAndDestroy();
      return;
    }

    const upstream = net.connect(upstreamPort, upstreamHost);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    upstream.pipe(client);

    if (!trusted) {
      untrusted.add(client);
      client.on("close", () => untrusted.delete(client));
    }
  });

  return {
    server,
    dropUntrusted() {
      for (const socket of untrusted) socket.resetAndDestroy();
      untrusted.clear();
    },
    rejectedLogSize() {
      return rejectedLog.size();
    },
  };
}

export function createDirectAccessTracker(initial, onTurnedOff) {
  let value = initial;
  return {
    get: () => value,
    set(next) {
      const turnedOff = value && !next;
      value = next;
      if (turnedOff) onTurnedOff();
    },
  };
}
