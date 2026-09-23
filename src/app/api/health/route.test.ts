import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/version", () => ({ APP_VERSION: "2026.9.20-e991c37" }));

const count = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { appSettings: { count: () => count() } },
}));

import { GET } from "./route";

describe("/api/health", () => {
  beforeEach(() => {
    count.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns ok with a version and timestamp when the database answers", async () => {
    count.mockResolvedValue(1);
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("ok");
    expect(body.version).toBe("2026.9.20-e991c37");
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });

  it("returns 503 when the database rejects", async () => {
    count.mockRejectedValue(new Error("connect ECONNREFUSED 172.18.0.2:5432"));
    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("error");
    expect(body.database).toBe("unreachable");
    expect(body.version).toBe("2026.9.20-e991c37");
  });

  it("does not leak the underlying error to the caller", async () => {
    count.mockRejectedValue(
      new Error("postgresql://blackvault:sekret@db:5432/blackvault"),
    );
    const body = await (await GET()).json();
    expect(JSON.stringify(body)).not.toContain("sekret");
  });

  it("returns 503 rather than hanging when the database never answers", async () => {
    vi.useFakeTimers();
    count.mockReturnValue(new Promise(() => {}));

    const pending = GET();
    await vi.advanceTimersByTimeAsync(5_000);

    const response = await pending;
    expect(response.status).toBe(503);
    expect((await response.json()).database).toBe("unreachable");
  });
});
