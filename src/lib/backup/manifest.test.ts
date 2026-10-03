import { describe, it, expect } from "vitest";
import { buildManifest, parseManifest, MANIFEST_FORMAT_VERSION, ManifestError, type Manifest } from "./manifest";

function validInput() {
  return {
    appVersion: "2026.10.2-abc1234",
    createdAt: new Date("2026-10-02T12:00:00.000Z"),
    keyIdAtBackup: "k_deadbeef",
    counts: { Firearm: 3, Accessory: 0 },
    files: [
      { path: "files/images/a.jpg", size: 1024, sha256: "a".repeat(64) },
      { path: "files/documents/b.pdf", size: 0, sha256: "0".repeat(64) },
    ],
    skipped: [{ path: "files/images/deleted.jpg", reason: "file removed during backup" }],
  };
}

describe("buildManifest", () => {
  it("produces exactly the spec's fields", () => {
    const manifest = buildManifest(validInput());
    expect(Object.keys(manifest).sort()).toEqual(
      ["formatVersion", "appVersion", "createdAt", "keyIdAtBackup", "counts", "files", "skipped"].sort(),
    );
    expect(manifest.formatVersion).toBe(MANIFEST_FORMAT_VERSION);
    expect(manifest.appVersion).toBe("2026.10.2-abc1234");
    expect(manifest.createdAt).toBe("2026-10-02T12:00:00.000Z");
    expect(manifest.keyIdAtBackup).toBe("k_deadbeef");
    expect(manifest.counts).toEqual({ Firearm: 3, Accessory: 0 });
    expect(manifest.files).toHaveLength(2);
    expect(manifest.skipped).toHaveLength(1);
  });

  it("defaults skipped to [] and createdAt to now when omitted", () => {
    const input = validInput();
    delete (input as { skipped?: unknown }).skipped;
    const before = Date.now();
    const manifest = buildManifest({ ...input, createdAt: undefined });
    const after = Date.now();
    expect(manifest.skipped).toEqual([]);
    const createdAtMs = Date.parse(manifest.createdAt);
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });

  it("accepts an already-ISO string for createdAt", () => {
    const manifest = buildManifest({ ...validInput(), createdAt: "2026-01-01T00:00:00.000Z" });
    expect(manifest.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an empty appVersion", () => {
    expect(() => buildManifest({ ...validInput(), appVersion: "" })).toThrow(ManifestError);
  });

  it("rejects a bad sha256", () => {
    const input = validInput();
    input.files[0].sha256 = "not-hex";
    expect(() => buildManifest(input)).toThrow(/sha256/);
  });

  it("rejects a negative size", () => {
    const input = validInput();
    input.files[0].size = -1;
    expect(() => buildManifest(input)).toThrow(/size/);
  });

  it("rejects a negative count", () => {
    const input = validInput();
    input.counts.Firearm = -1;
    expect(() => buildManifest(input)).toThrow(/counts/);
  });

  it("does not let later mutation of the input affect the returned manifest", () => {
    const input = validInput();
    const manifest = buildManifest(input);
    input.counts.Firearm = 999;
    input.files.push({ path: "x", size: 1, sha256: "1".repeat(64) });
    expect(manifest.counts.Firearm).toBe(3);
    expect(manifest.files).toHaveLength(2);
  });
});

describe("parseManifest", () => {
  it("round-trips what buildManifest produces", () => {
    const built = buildManifest(validInput());
    const parsed = parseManifest(Buffer.from(JSON.stringify(built), "utf8"));
    expect(parsed).toEqual(built);
  });

  it("accepts a plain string too", () => {
    const built = buildManifest(validInput());
    expect(parseManifest(JSON.stringify(built))).toEqual(built);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseManifest("{not json")).toThrow(ManifestError);
  });

  it("rejects a non-object JSON value", () => {
    expect(() => parseManifest("[1,2,3]")).toThrow(/object/);
  });

  it("rejects an unknown formatVersion", () => {
    const built = buildManifest(validInput()) as Manifest;
    const tampered = { ...built, formatVersion: 2 };
    expect(() => parseManifest(JSON.stringify(tampered))).toThrow(/formatVersion/);
  });

  it("rejects a missing formatVersion", () => {
    const built = buildManifest(validInput()) as unknown as Record<string, unknown>;
    delete built.formatVersion;
    expect(() => parseManifest(JSON.stringify(built))).toThrow(/formatVersion/);
  });

  it("rejects a manifest missing files", () => {
    const built = buildManifest(validInput()) as unknown as Record<string, unknown>;
    delete built.files;
    expect(() => parseManifest(JSON.stringify(built))).toThrow(/files/);
  });

  it("rejects a file entry with a bad sha256", () => {
    const built = buildManifest(validInput());
    built.files[0].sha256 = "short";
    expect(() => parseManifest(JSON.stringify(built))).toThrow(/sha256/);
  });

  it("rejects a skipped entry missing a reason", () => {
    const built = buildManifest(validInput()) as unknown as { skipped: Array<Record<string, unknown>> };
    delete built.skipped[0].reason;
    expect(() => parseManifest(JSON.stringify(built))).toThrow(/reason/);
  });
});
