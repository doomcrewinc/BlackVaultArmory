// Client-safe: no server imports.

export type PassNetwork = {
  lanUrl: string | null;
  publicUrl: string | null;
  directAccess: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const UNREACHABLE_MESSAGE =
  'Your phone cannot reach "localhost". Open BlackVault on this computer by its network address, then try again.';

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_HOSTS.has(hostnameOf(origin));
}

/**
 * The address a phone should open. An origin the laptop reached by a real name
 * or address is used as it is. From a loopback origin the phone needs another
 * address: the public URL when direct access is off (the app redirects every
 * other host there), otherwise the detected network address.
 */
export function passUrl(
  origin: string,
  path: string,
  net: PassNetwork | null,
): { url: string; reachable: boolean } {
  const own = trimSlash(origin) + path;
  if (!isLoopbackOrigin(origin)) return { url: own, reachable: true };

  if (net && !net.directAccess && net.publicUrl) {
    return { url: trimSlash(net.publicUrl) + path, reachable: true };
  }
  if (net?.lanUrl) return { url: trimSlash(net.lanUrl) + path, reachable: true };
  return { url: own, reachable: false };
}
