import { describe, expect, it } from "vitest";
import { hostPathOf, snapshotStamp } from "./pre-encryption-snapshot";

describe("hostPathOf (fix round 1, M14)", () => {
  it("maps /app/data/<file> to BLACKVAULT_HOST_DB_DIR/<file>", () => {
    expect(hostPathOf("/app/data/pre-encryption-20261001-120000.db", { BLACKVAULT_HOST_DB_DIR: "/srv/bv/data/db" }))
      .toBe("/srv/bv/data/db/pre-encryption-20261001-120000.db");
    expect(hostPathOf("/app/data/x.db", { BLACKVAULT_HOST_DB_DIR: "C:\\BlackVault\\data/db" })).toBe("C:/BlackVault/data/db/x.db");
  });

  it("without the variable, says where it is on the host in words", () => {
    expect(hostPathOf("/app/data/x.db", {})).toBe(
      "/app/data/x.db (in the container; on the host it is in the db/ folder of your BlackVault data directory)",
    );
  });

  it("leaves a path outside the container's data folder as it is (not in Docker)", () => {
    expect(hostPathOf("/home/me/bv/prisma/dev/pre-encryption-1.db", { BLACKVAULT_HOST_DB_DIR: "/x" })).toBe(
      "/home/me/bv/prisma/dev/pre-encryption-1.db",
    );
  });
});

describe("snapshotStamp", () => {
  it("is YYYYmmdd-HHMMSS in UTC", () => {
    expect(snapshotStamp(new Date(Date.UTC(2026, 9, 1, 3, 4, 5)))).toBe("20261001-030405");
  });
});
