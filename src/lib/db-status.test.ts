import { describe, expect, it, vi } from "vitest";
import { looksLikeOutage, probeDatabase } from "./db-status";

const ORIGIN = "http://localhost:3000";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("looksLikeOutage", () => {
  it("flags this app's own server errors", () => {
    expect(looksLikeOutage("/api/firearms", 503, ORIGIN)).toBe(true);
    expect(looksLikeOutage("/api/firearms", 500, ORIGIN)).toBe(true);
    expect(looksLikeOutage(`${ORIGIN}/vault/1`, 502, ORIGIN)).toBe(true);
  });

  it("ignores the health probe itself, so verification cannot recurse", () => {
    expect(looksLikeOutage("/api/health", 503, ORIGIN)).toBe(false);
  });

  it("ignores client errors and other origins", () => {
    expect(looksLikeOutage("/api/firearms", 404, ORIGIN)).toBe(false);
    expect(looksLikeOutage("/api/firearms", 400, ORIGIN)).toBe(false);
    expect(looksLikeOutage("https://example.com/x", 500, ORIGIN)).toBe(false);
  });

  it("ignores an unparseable url instead of throwing", () => {
    expect(looksLikeOutage("::::", 500, "not-an-origin")).toBe(false);
  });
});

describe("probeDatabase", () => {
  it("reports ok when health says the database answers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "ok", database: "ok" }));
    await expect(
      probeDatabase(fetchImpl as unknown as typeof fetch),
    ).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reports db-down on the 503 the health route returns", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(503, { status: "error", database: "unreachable" }),
      );
    await expect(
      probeDatabase(fetchImpl as unknown as typeof fetch),
    ).resolves.toBe("db-down");
  });

  it("reports unreachable when the server does not answer at all", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      probeDatabase(fetchImpl as unknown as typeof fetch),
    ).resolves.toBe("unreachable");
  });

  it("reports unreachable for a proxy 502 or 504", async () => {
    for (const status of [502, 504]) {
      const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status }));
      await expect(
        probeDatabase(fetchImpl as unknown as typeof fetch),
      ).resolves.toBe("unreachable");
    }
  });

  it("never blocks the app on something it cannot interpret", async () => {
    const unreadable = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 200 }));
    await expect(
      probeDatabase(unreadable as unknown as typeof fetch),
    ).resolves.toBe("ok");

    const unrelated = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 500 }));
    await expect(
      probeDatabase(unrelated as unknown as typeof fetch),
    ).resolves.toBe("ok");
  });

  it("treats a 200 that omits the database field as an outage", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "ok" }));
    await expect(
      probeDatabase(fetchImpl as unknown as typeof fetch),
    ).resolves.toBe("db-down");
  });
});
