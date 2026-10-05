import { isIP } from "node:net";

const BRACKETED = /^\[([^\]]+)\](?::\d{1,5})?$/;
const IPV4_WITH_PORT = /^([^:]+):\d{1,5}$/;

/**
 * The bare IP address in a forwarded-for value, or null when it is not one.
 * Accepts `addr`, `addr:port` (IPv4), `[addr]` and `[addr]:port`; a bare IPv6
 * address is left alone, its colons being part of it.
 */
export function normaliseAddress(raw: string): string | null {
  let candidate = raw;
  if (isIP(candidate) === 0) {
    const bracketed = BRACKETED.exec(candidate);
    const withPort = IPV4_WITH_PORT.exec(candidate);
    if (bracketed) candidate = bracketed[1];
    else if (withPort) candidate = withPort[1];
  }
  return isIP(candidate) === 0 ? null : candidate;
}
