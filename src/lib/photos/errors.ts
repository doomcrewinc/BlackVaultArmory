/** The error's class name and `code` when it has one: enough to diagnose, never its message. */
export function describeError(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? `${name} ${code}` : name;
}
