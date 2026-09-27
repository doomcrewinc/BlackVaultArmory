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
 * @param {{
 *   upstreamHost?: string,
 *   upstreamPort: number,
 *   isTrusted: (ip: string) => boolean,
 *   getDirectAccess: () => boolean,
 *   trustLoopback?: boolean,
 *   log?: GateLogger,
 * }} options
 */
export function createGate({
  upstreamHost = "127.0.0.1",
  upstreamPort,
  isTrusted,
  getDirectAccess,
  trustLoopback = true,
  log = console,
}) {
  const untrusted = new Set();
  const lastLogged = new Map();

  function logRejected(peer) {
    const now = Date.now();
    const key = peer ?? "unknown";
    if (now - (lastLogged.get(key) ?? -Infinity) < LOG_INTERVAL_MS) return;
    lastLogged.set(key, now);
    log.warn(`[gate] rejected ${key} (not a trusted proxy; direct access off)`);
  }

  const server = net.createServer((client) => {
    const peer = normalizePeer(client.remoteAddress);
    const trusted = peer !== null && ((trustLoopback && isLoopback(peer)) || isTrusted(peer));

    if (!trusted && !getDirectAccess()) {
      logRejected(peer);
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
