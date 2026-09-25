import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_MODELS, REQUIRED_BACKUP_KEYS } from "@/lib/backup/models";

type Call = {
  op: "deleteMany" | "createMany";
  delegate: string;
  data?: unknown[];
};

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  transaction: vi.fn(),
  runConfiguredDateMigration: vi.fn(),
  appSettings: {
    deleteMany: vi.fn(),
    createMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/date-migration", () => ({
  runConfiguredDateMigration: mocks.runConfiguredDateMigration,
}));

import { POST } from "./route";

function makeTx() {
  const tx: Record<string, unknown> = { appSettings: mocks.appSettings };
  for (const { delegate } of BACKUP_MODELS) {
    tx[delegate] = {
      deleteMany: vi.fn(async () => {
        mocks.calls.push({ op: "deleteMany", delegate });
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        mocks.calls.push({ op: "createMany", delegate, data });
        return { count: data.length };
      }),
    };
  }
  return tx;
}

function restoreRequest(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const V1_0_KEYS = [
  "firearms",
  "builds",
  "buildSlots",
  "accessories",
  "documents",
  "roundCountLogs",
  "ammoStocks",
  "ammoTransactions",
  "rangeSessions",
  "rangeSessionAmmoLinks",
  "sessionDrills",
  "imageCache",
];

function v11Payload() {
  return {
    meta: { version: "1.1" },
    ...Object.fromEntries(
      BACKUP_MODELS.map(({ key }) => [key, [{ id: `${key}-1` }]]),
    ),
  };
}

const created = (delegate: string) =>
  mocks.calls.find((c) => c.op === "createMany" && c.delegate === delegate)
    ?.data;

describe("POST /api/backup/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.transaction.mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
    );
    mocks.runConfiguredDateMigration.mockResolvedValue(undefined);
  });

  it("restores maintenance, battery, and date-audit rows from a v1.1 payload", async () => {
    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(created("maintenanceLog")).toEqual([{ id: "maintenanceLogs-1" }]);
    expect(created("batteryChangeLog")).toEqual([
      { id: "batteryChangeLogs-1" },
    ]);
    expect(created("dateNormalizationAudit")).toEqual([
      { id: "dateNormalizationAudits-1" },
    ]);
    for (const { key } of BACKUP_MODELS) expect(json.counts[key], key).toBe(1);
  });

  it("restores a v1.1 payload that omits gear, leaving other tables intact", async () => {
    const { gear: _gear, ...payload } = v11Payload() as Record<string, unknown>;
    void _gear;

    const response = await POST(restoreRequest(payload));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(created("gear")).toBeUndefined();
    expect(json.counts.gear).toBe(0);
    // toMatchObject, not toEqual: restore re-derives the NFA group on every
    // firearm row, so the row it writes also carries nfaClass and the five
    // paperwork columns (see the normalization test below).
    expect(created("firearm")).toMatchObject([{ id: "firearms-1" }]);
    expect(created("document")).toEqual([{ id: "documents-1" }]);
    expect(created("maintenanceLog")).toEqual([{ id: "maintenanceLogs-1" }]);
  });

  it("accepts a v1.0 payload that lacks the new keys, treating them as empty", async () => {
    const payload = {
      meta: { version: "1.0" },
      ...Object.fromEntries(
        V1_0_KEYS.map((key) => [key, [{ id: `${key}-1` }]]),
      ),
    };

    const response = await POST(restoreRequest(payload));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(created("firearm")).toMatchObject([{ id: "firearms-1" }]);
    expect(created("maintenanceLog")).toBeUndefined();
    expect(json.counts.maintenanceLogs).toBe(0);
    expect(json.counts.batteryChangeLogs).toBe(0);
    expect(json.counts.dateNormalizationAudits).toBe(0);
  });

  // The clearing rules have to hold however a write arrives, and restore is a
  // write path: it hands uploaded JSON to createMany with no validation beyond
  // "is it an array". A hand-edited or foreign backup must not be able to
  // reintroduce paperwork onto a Title I firearm.
  it("clears paperwork carried by a Title I firearm in the payload", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        firearms: [
          {
            id: "firearms-1",
            name: "Plain Rifle",
            type: "RIFLE",
            nfaClass: "NONE",
            mgRegistry: "TRANSFERABLE",
            nfaTransferMethod: "FORM_4",
            nfaControlNumber: "12345",
            nfaApprovalDate: "2024-03-12T00:00:00.000Z",
            nfaTaxPaid: 200,
            nfaRegisteredTo: "Doe Family Trust",
          },
        ],
      }),
    );

    const [row] = created("firearm") as Record<string, unknown>[];
    expect(row.name).toBe("Plain Rifle");
    expect(row.nfaClass).toBe("NONE");
    expect(row.mgRegistry).toBeNull();
    expect(row.nfaTransferMethod).toBeNull();
    expect(row.nfaControlNumber).toBeNull();
    expect(row.nfaApprovalDate).toBeNull();
    expect(row.nfaTaxPaid).toBeNull();
    expect(row.nfaRegisteredTo).toBeNull();
  });

  // The other side of that rule. An unknown class is not a hand-edited file:
  // it is a backup from a later build that added an NFA class, which the
  // category registry's catch-all section documents and accommodates.
  // Coercing it to NONE would drop mgRegistry and all five paperwork columns
  // on a data-recovery path — silently, and for input the write routes answer
  // 400 for rather than perform.
  it("leaves a firearm with an unknown nfaClass and its paperwork untouched", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        firearms: [
          {
            id: "firearms-1",
            name: "Future Class Item",
            type: "RIFLE",
            nfaClass: "SHORT_BARRELED_SHOTGUN_MK2",
            mgRegistry: "PRE_SAMPLE",
            nfaTransferMethod: "FORM_4",
            nfaControlNumber: "12345",
            nfaApprovalDate: "2024-03-12T00:00:00.000Z",
            nfaTaxPaid: 200,
            nfaRegisteredTo: "Doe Family Trust",
          },
        ],
      }),
    );

    const [row] = created("firearm") as Record<string, unknown>[];
    expect(row.nfaClass).toBe("SHORT_BARRELED_SHOTGUN_MK2");
    expect(row.mgRegistry).toBe("PRE_SAMPLE");
    expect(row.nfaTransferMethod).toBe("FORM_4");
    expect(row.nfaControlNumber).toBe("12345");
    expect(row.nfaTaxPaid).toBe(200);
    expect(row.nfaRegisteredTo).toBe("Doe Family Trust");
    // Verbatim, not re-derived: the date is still the string from the file.
    expect(row.nfaApprovalDate).toBe("2024-03-12T00:00:00.000Z");
  });

  // Same rule, the armor group. normalizeGearArmorFields' own docblock names
  // "restore and the copier" as the callers that matter, and restore is the
  // one that has to enforce it: the copier's job is a faithful whole-row copy.
  it("clears the armor fields carried by a non-armor gear row in the payload", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        gear: [
          {
            id: "gear-1",
            name: "Hand-edited Knife",
            category: "KNIFE",
            protectionLevel: "IV",
            armorSize: "SAPI M",
          },
        ],
      }),
    );

    const [row] = created("gear") as Record<string, unknown>[];
    expect(row.name).toBe("Hand-edited Knife");
    expect(row.category).toBe("KNIFE");
    expect(row.protectionLevel).toBeNull();
    expect(row.armorSize).toBeNull();
  });

  it("restores a legitimate armor row with its armor fields intact", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        gear: [
          {
            id: "gear-1",
            name: "Plate Carrier",
            category: "ARMOR",
            protectionLevel: "III",
            armorSize: "L",
          },
        ],
      }),
    );

    const [row] = created("gear") as Record<string, unknown>[];
    expect(row.protectionLevel).toBe("III");
    expect(row.armorSize).toBe("L");
  });

  // The other side, and the one an earlier phase of this epic got wrong on
  // the NFA columns: a category from a LATER build cannot be judged here, so
  // clearing it would silently destroy data on a recovery path.
  it("leaves a gear row with an unrecognised category and its armor fields untouched", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        gear: [
          {
            id: "gear-1",
            name: "Future Exosuit",
            category: "EXOSUIT",
            protectionLevel: "IV",
            armorSize: "SAPI M",
          },
        ],
      }),
    );

    const [row] = created("gear") as Record<string, unknown>[];
    expect(row.category).toBe("EXOSUIT");
    expect(row.protectionLevel).toBe("IV");
    expect(row.armorSize).toBe("SAPI M");
  });

  it("clears paperwork carried by a non-suppressor accessory in the payload", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        accessories: [
          {
            id: "accessories-1",
            name: "Red Dot",
            type: "OPTIC",
            nfaTransferMethod: "FORM_4",
            nfaControlNumber: "SUP-1",
            nfaApprovalDate: "2025-02-20T00:00:00.000Z",
            nfaTaxPaid: 200,
            nfaRegisteredTo: "Doe Family Trust",
          },
        ],
      }),
    );

    const [row] = created("accessory") as Record<string, unknown>[];
    expect(row.name).toBe("Red Dot");
    expect(row.nfaTransferMethod).toBeNull();
    expect(row.nfaControlNumber).toBeNull();
    expect(row.nfaApprovalDate).toBeNull();
    expect(row.nfaTaxPaid).toBeNull();
    expect(row.nfaRegisteredTo).toBeNull();
  });

  it("restores a legitimate SBR and suppressor with their paperwork intact", async () => {
    await POST(
      restoreRequest({
        ...v11Payload(),
        firearms: [
          {
            id: "firearms-1",
            name: "Short Carbine",
            type: "RIFLE",
            nfaClass: "SBR",
            nfaTransferMethod: "FORM_4",
            nfaControlNumber: "12345",
            nfaApprovalDate: "2024-03-12T00:00:00.000Z",
            nfaTaxPaid: 200,
            nfaRegisteredTo: "Doe Family Trust",
          },
        ],
        accessories: [
          {
            id: "accessories-1",
            name: "House Can",
            type: "SUPPRESSOR",
            nfaTransferMethod: "FORM_4",
            nfaControlNumber: "SUP-1",
            nfaApprovalDate: "2025-02-20T00:00:00.000Z",
            nfaTaxPaid: 200,
            nfaRegisteredTo: "Doe Family Trust",
          },
        ],
      }),
    );

    const [firearm] = created("firearm") as Record<string, unknown>[];
    expect(firearm.nfaClass).toBe("SBR");
    expect(firearm.nfaTransferMethod).toBe("FORM_4");
    expect(firearm.nfaControlNumber).toBe("12345");
    expect(firearm.nfaTaxPaid).toBe(200);
    expect(firearm.nfaRegisteredTo).toBe("Doe Family Trust");
    // A date-only column: the ISO string in the file comes back as the same
    // UTC calendar day, not shifted.
    expect((firearm.nfaApprovalDate as Date).toISOString().slice(0, 10)).toBe(
      "2024-03-12",
    );

    const [accessory] = created("accessory") as Record<string, unknown>[];
    expect(accessory.nfaTransferMethod).toBe("FORM_4");
    expect(accessory.nfaControlNumber).toBe("SUP-1");
    expect(accessory.nfaRegisteredTo).toBe("Doe Family Trust");
  });

  it("rejects a truncated payload with only firearms and deletes nothing", async () => {
    const response = await POST(
      restoreRequest({
        meta: { version: "1.1" },
        firearms: [{ id: "firearms-1" }],
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.calls.filter((c) => c.op === "deleteMany")).toEqual([]);
  });

  it.each(V1_0_KEYS)(
    "rejects a payload missing the v1.0 key %s and deletes nothing",
    async (key) => {
      const { [key]: _dropped, ...partial } = v11Payload() as Record<
        string,
        unknown
      >;
      void _dropped;

      const response = await POST(restoreRequest(partial));

      expect(response.status).toBe(400);
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.calls).toEqual([]);
    },
  );

  it("rejects a payload where a v1.0 key is null", async () => {
    const response = await POST(
      restoreRequest({ ...v11Payload(), sessionDrills: null }),
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires exactly the v1.0 keys; only post-v1.0 keys are optional", () => {
    // Not a positional slice: Gear sits ahead of Document in BACKUP_MODELS
    // (restore-order, FK-safe) but must not become a required key for that reason.
    expect([...REQUIRED_BACKUP_KEYS].sort()).toEqual([...V1_0_KEYS].sort());
    const optionalKeys = BACKUP_MODELS.map((m) => m.key).filter(
      (key) => !REQUIRED_BACKUP_KEYS.includes(key),
    );
    expect(optionalKeys.sort()).toEqual(
      [
        "gear",
        "supplies",
        "maintenanceLogs",
        "batteryChangeLogs",
        "dateNormalizationAudits",
        "kits",
        "kitItems",
      ].sort(),
    );
  });

  it("rejects a payload with no meta.version", async () => {
    const { meta: _meta, ...noMeta } = v11Payload();
    void _meta;

    const response = await POST(restoreRequest(noMeta));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a payload where a known key is not an array", async () => {
    const response = await POST(
      restoreRequest({ ...v11Payload(), maintenanceLogs: "nope" }),
    );

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("deletes children before parents, then inserts parents before children", async () => {
    await POST(restoreRequest(v11Payload()));

    const deletes = mocks.calls
      .filter((c) => c.op === "deleteMany")
      .map((c) => c.delegate);
    const inserts = mocks.calls
      .filter((c) => c.op === "createMany")
      .map((c) => c.delegate);
    const order = BACKUP_MODELS.map((m) => m.delegate);

    expect(deletes).toEqual([...order].reverse());
    expect(inserts).toEqual(order);
    expect(mocks.calls.findIndex((c) => c.op === "createMany")).toBe(
      order.length,
    );
    expect(deletes.indexOf("maintenanceLog")).toBeLessThan(
      deletes.indexOf("firearm"),
    );
    expect(deletes.indexOf("batteryChangeLog")).toBeLessThan(
      deletes.indexOf("accessory"),
    );
  });

  it("never touches AppSettings", async () => {
    await POST(
      restoreRequest({ ...v11Payload(), appSettings: [{ id: "singleton" }] }),
    );

    for (const fn of Object.values(mocks.appSettings))
      expect(fn).not.toHaveBeenCalled();
  });

  it("runs the post-restore date migration after a successful restore", async () => {
    await POST(restoreRequest(v11Payload()));

    expect(mocks.runConfiguredDateMigration).toHaveBeenCalledTimes(1);
    expect(mocks.runConfiguredDateMigration).toHaveBeenCalledWith("restore");
  });

  it("still reports success when the post-restore migration throws", async () => {
    mocks.runConfiguredDateMigration.mockRejectedValue(
      new Error("migration boom"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.error).toBeUndefined();
    spy.mockRestore();
  });

  it("reports 'not modified' and skips the migration when the transaction fails", async () => {
    mocks.transaction.mockRejectedValue(new Error("tx boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toMatch(/has not been modified/);
    expect(mocks.runConfiguredDateMigration).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
