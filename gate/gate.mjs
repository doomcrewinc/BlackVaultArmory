// Container entry point (Dockerfile CMD). Owns the public port, starts Next's
// standalone server on 127.0.0.1:3001 in this same process, and gates every
// connection. Dev (`npm run dev`) does not use this file.
import dns from "node:dns/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildMatcher, parseTrustedProxies } from "./gate-core.mjs";
import { createDirectAccessTracker, createGate } from "./gate-server.mjs";

const GATE_PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_PORT = 3001;
const POLL_MS = 5_000;
const RESOLVE_MS = 30_000;

const parsed = parseTrustedProxies(process.env.TRUSTED_PROXIES);
for (const entry of parsed.invalid) console.warn(`[gate] ignoring invalid BLACKVAULT_TRUSTED_PROXIES entry: ${entry}`);
for (const { address, prefix } of parsed.cidrs) {
  if (prefix === 0) {
    const entry = `${address}/${prefix}`;
    console.warn(
      `[gate] WARNING: BLACKVAULT_TRUSTED_PROXIES entry ${entry} trusts every address — this disables connection resets entirely`,
    );
  }
}

const resolved = new Map(); // host name -> last good IPs
let matcher = buildMatcher(parsed, []);

async function resolveHostnames() {
  for (const name of parsed.hostnames) {
    try {
      const addresses = await dns.lookup(name, { all: true });
      resolved.set(name, addresses.map((a) => a.address));
    } catch (error) {
      console.warn(`[gate] could not resolve trusted proxy "${name}"; keeping the last good address: ${error.code ?? error}`);
    }
  }
  matcher = buildMatcher(parsed, [...resolved.values()].flat());
}

await resolveHostnames();
setInterval(resolveHostnames, RESOLVE_MS).unref();

const forced = process.env.ALLOW_DIRECT_ACCESS === "true";
if (parsed.ips.length + parsed.cidrs.length + parsed.hostnames.length === 0 && !forced) {
  console.warn("[gate] BLACKVAULT_TRUSTED_PROXIES is empty: while direct access is off, all non-loopback connections will be reset");
}
try {
  await dns.lookup("host.docker.internal");
  console.warn("[gate] Docker Desktop detected: peer addresses are unreliable here, so trusted-proxy matching may not tell your proxy apart from other clients");
} catch {
  // Not Docker Desktop.
}

let gate;
const tracker = createDirectAccessTracker(forced, () => gate.dropUntrusted());
gate = createGate({
  upstreamPort: UPSTREAM_PORT,
  isTrusted: (ip) => matcher(ip),
  getDirectAccess: () => tracker.get(),
});

setInterval(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/internal/gate-config`);
    const body = await res.json();
    tracker.set(body.allowDirectAccess === true);
  } catch {
    // Next still starting, or briefly unavailable: keep the current value.
  }
}, POLL_MS).unref();

gate.server.listen(GATE_PORT, () => console.log(`[gate] listening on :${GATE_PORT}, upstream 127.0.0.1:${UPSTREAM_PORT}`));

// Next's standalone server reads PORT and HOSTNAME when it loads.
process.env.PORT = String(UPSTREAM_PORT);
process.env.HOSTNAME = "127.0.0.1";
await import(pathToFileURL(path.resolve(process.cwd(), "server.js")).href);
