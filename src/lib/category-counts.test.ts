import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CategoryCounts } from "./category-counts";

// The module keeps its in-flight promise in module scope, so each test needs
// a fresh module instance to avoid leaking state between cases.
async function freshModule() {
  vi.resetModules();
  return import("./category-counts");
}

function jsonResponse(body: CategoryCounts, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCategoryCounts", () => {
  it("shares one underlying fetch across concurrent callers", async () => {
    const { fetchCategoryCounts } = await freshModule();
    const body: CategoryCounts = { counts: { handguns: 1 }, legacySmgCount: 0 };
    let resolveFetch: (value: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal("fetch", fetchMock);

    const first = fetchCategoryCounts();
    const second = fetchCategoryCounts();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch!(jsonResponse(body));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(body);
    expect(secondResult).toEqual(body);
    expect(secondResult).toBe(firstResult);
  });

  it("fetches again for a caller arriving after the first request settled", async () => {
    const { fetchCategoryCounts } = await freshModule();
    const bodyOne: CategoryCounts = {
      counts: { handguns: 1 },
      legacySmgCount: 0,
    };
    const bodyTwo: CategoryCounts = {
      counts: { handguns: 2 },
      legacySmgCount: 0,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(bodyOne))
      .mockResolvedValueOnce(jsonResponse(bodyTwo));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchCategoryCounts();
    const second = await fetchCategoryCounts();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first).toEqual(bodyOne);
    expect(second).toEqual(bodyTwo);
  });

  it("resolves to null on a non-ok response", async () => {
    const { fetchCategoryCounts } = await freshModule();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ counts: {}, legacySmgCount: 0 }, false),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCategoryCounts()).resolves.toBeNull();
  });

  it("resolves to null when fetch throws", async () => {
    const { fetchCategoryCounts } = await freshModule();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCategoryCounts()).resolves.toBeNull();
  });

  it("does not let a failed request poison the next call", async () => {
    const { fetchCategoryCounts } = await freshModule();
    const body: CategoryCounts = { counts: { handguns: 3 }, legacySmgCount: 1 };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);

    const failed = await fetchCategoryCounts();
    expect(failed).toBeNull();

    const succeeded = await fetchCategoryCounts();
    expect(succeeded).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
