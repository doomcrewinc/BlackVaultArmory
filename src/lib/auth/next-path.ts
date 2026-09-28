const AUTH_PAGES = new Set(["/login", "/setup"]);

/** Where to send someone after login. Only same-origin paths; never back to an auth page. */
export function safeNextPath(input: string | null | undefined): string {
  if (!input || !input.startsWith("/") || input.startsWith("//") || input.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f]/.test(input)) return "/";
  const path = input.split(/[?#]/)[0];
  return AUTH_PAGES.has(path) ? "/" : input;
}
