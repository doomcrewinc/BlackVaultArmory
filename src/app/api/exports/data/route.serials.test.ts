import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  firearmFindMany: vi.fn(),
  accessoryFindMany: vi.fn(),
  gearFindMany: vi.fn(),
  kitFindMany: vi.fn(),
  buildFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  ammoStockFindMany: vi.fn(),
  rangeSessionFindMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: {
      findUnique: mocks.appSettingsFindUnique,
    },
    firearm: {
      findMany: mocks.firearmFindMany,
    },
    accessory: {
      findMany: mocks.accessoryFindMany,
    },
    gear: {
      findMany: mocks.gearFindMany,
    },
    kit: {
      findMany: mocks.kitFindMany,
    },
    build: {
      findMany: mocks.buildFindMany,
    },
    document: {
      findMany: mocks.documentFindMany,
    },
    ammoStock: {
      findMany: mocks.ammoStockFindMany,
    },
    rangeSession: {
      findMany: mocks.rangeSessionFindMany,
    },
  },
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
}));

import { GET } from "./route";

// Every section that can carry a serial is on: firearms, accessories, gear and
// builds (whose slots embed a whole Accessory row).
const BASE_QUERY =
  "format=csv&firearms=true&accessories=true&gear=true&builds=true&ammo=false&rangeSessions=false&documents=false&settings=false";

// The route's GET is typed as possibly returning undefined (it falls off the end
// for a format that parseFormat already rejected), so narrow it once here rather
// than at every call site.
async function callExport(query: string): Promise<{ status: number; body: string }> {
  const response = await GET(new NextRequest(`http://localhost/api/exports/data?${query}`));
  if (!response) throw new Error("export route returned no response");
  return { status: response.status, body: await response.text() };
}

describe("/api/exports/data serial number handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({
      id: "singleton",
      includeUploadsInBackup: false,
    });

    mocks.firearmFindMany.mockResolvedValue([
      { id: "f1", name: "Duty Rifle", manufacturer: "Acme", serialNumber: "FIREARM-SERIAL-1" },
    ]);

    mocks.accessoryFindMany.mockResolvedValue([
      { id: "a1", name: "Optic", manufacturer: "DotCo", serialNumber: "ACCESSORY-SERIAL-1" },
    ]);

    mocks.gearFindMany.mockResolvedValue([
      { id: "g1", name: "Bugout", manufacturer: "Benchmade", category: "KNIFE", serialNumber: "GEAR-SERIAL-1" },
    ]);

    mocks.buildFindMany.mockResolvedValue([
      {
        id: "b1",
        name: "Patrol Build",
        firearmId: "f1",
        slots: [
          {
            id: "s1",
            buildId: "b1",
            slotType: "OPTIC",
            accessoryId: "a1",
            accessory: { id: "a1", name: "Optic", manufacturer: "DotCo", serialNumber: "ACCESSORY-SERIAL-1" },
          },
          {
            id: "s2",
            buildId: "b1",
            slotType: "GRIP",
            accessoryId: null,
            accessory: null,
          },
        ],
      },
    ]);

    // A kit line pointing at the SAME firearm and accessory rows as above —
    // the nested shape a build's slots have, one table further out.
    mocks.kitFindMany.mockResolvedValue([
      {
        id: "k1",
        name: "Range Bag",
        category: "RANGE",
        items: [
          {
            id: "ki1",
            kitId: "k1",
            firearmId: "f1",
            firearm: { id: "f1", name: "Duty Rifle", serialNumber: "FIREARM-SERIAL-1" },
          },
          {
            id: "ki2",
            kitId: "k1",
            accessoryId: "a1",
            accessory: { id: "a1", name: "Optic", serialNumber: "ACCESSORY-SERIAL-1" },
          },
        ],
      },
    ]);

    mocks.documentFindMany.mockResolvedValue([]);
    mocks.ammoStockFindMany.mockResolvedValue([]);
    mocks.rangeSessionFindMany.mockResolvedValue([]);
  });

  it("keeps a kit line's firearm and accessory serials out of the export", async () => {
    const withoutSerials = await callExport(`${BASE_QUERY}&kits=true`);

    const kitLines = withoutSerials.body.split("\n").filter((line) => line.startsWith("kits,"));
    expect(kitLines).toHaveLength(1);
    // The lines array is JSON-stringified into the row, nested rows and all,
    // so the kit is genuinely exported — only the serials are withheld.
    expect(kitLines[0]).toContain("Range Bag");
    expect(kitLines[0]).toContain("Duty Rifle");
    expect(kitLines[0]).not.toContain("FIREARM-SERIAL-1");
    expect(kitLines[0]).not.toContain("ACCESSORY-SERIAL-1");

    const withSerials = await callExport(`${BASE_QUERY}&kits=true&includeSerialNumbers=true`);
    const withSerialsKitLine = withSerials.body
      .split("\n")
      .find((line) => line.startsWith("kits,"));
    expect(withSerialsKitLine).toContain("FIREARM-SERIAL-1");
    expect(withSerialsKitLine).toContain("ACCESSORY-SERIAL-1");
  });

  it("keeps an accessory serial number out of the export unless it was requested", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    expect(withoutSerials.status).toBe(200);
    // The accessory is still exported — only its serial is withheld.
    expect(withoutSerials.body).toContain("Optic");
    expect(withoutSerials.body).not.toContain("ACCESSORY-SERIAL-1");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);

    expect(withSerials.body).toContain("ACCESSORY-SERIAL-1");
  });

  it("keeps the accessory serial out of a build's embedded slot rows too", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    const buildLines = withoutSerials.body.split("\n").filter((line) => line.startsWith("builds,"));
    expect(buildLines).toHaveLength(1);
    // The slots array is JSON-stringified into the row, accessory row and all.
    expect(buildLines[0]).toContain("Patrol Build");
    expect(buildLines[0]).toContain("OPTIC");
    expect(buildLines[0]).not.toContain("ACCESSORY-SERIAL-1");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);
    const withSerialsBuildLine = withSerials.body
      .split("\n")
      .find((line) => line.startsWith("builds,"));
    expect(withSerialsBuildLine).toContain("ACCESSORY-SERIAL-1");
  });

  it("leaves an empty slot alone while stripping its neighbour", async () => {
    const { body: csv } = await callExport(BASE_QUERY);

    const buildLine = csv.split("\n").find((line) => line.startsWith("builds,"));
    // Both slots survive; only the populated one was rewritten.
    expect(buildLine).toContain("GRIP");
    expect(buildLine).toContain("OPTIC");
    expect(buildLine).not.toContain("ACCESSORY-SERIAL-1");
  });

  it("still strips firearm and gear serials, and still emits all three sections", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    expect(withoutSerials.body).not.toContain("FIREARM-SERIAL-1");
    expect(withoutSerials.body).not.toContain("GEAR-SERIAL-1");
    expect(withoutSerials.body).toContain("Duty Rifle");
    expect(withoutSerials.body).toContain("Bugout");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);

    expect(withSerials.body).toContain("FIREARM-SERIAL-1");
    expect(withSerials.body).toContain("GEAR-SERIAL-1");
  });
});

/**
 * The whole-payload sweep.
 *
 * Serials have leaked out of this route FOUR separate ways in this epic, and
 * the fourth — an Accessory row embedded two levels down inside a build's
 * slots — got past tests that checked the top-level `accessories` array. So
 * these assertions do not name a nesting path at all: they serialize the
 * ENTIRE response and require that the sentinel string appears NOWHERE in it.
 * That is the only formulation that would have caught the fourth leak, and the
 * only one that covers a fifth nobody has thought of yet.
 *
 * Every section is on, including the ones the other suites leave off, because
 * a section that is off cannot leak and cannot prove anything either.
 */
describe("/api/exports/data — the serial sentinel sweep", () => {
  // Distinctive enough that a substring match is meaningful, and impossible to
  // produce by accident from any other field in the payload.
  const GEAR_SENTINEL = "ZZ-GEAR-SENTINEL-7391";
  // A sentinel of its own for the kit path, so a failure names which nesting
  // leaked rather than pointing at the gear row nine assertions away.
  const KIT_FIREARM_SENTINEL = "ZZ-KIT-FIREARM-SENTINEL-4417";
  const ALL_SECTIONS =
    "firearms=true&accessories=true&gear=true&builds=true&ammo=true&kits=true&rangeSessions=true&documents=true&settings=true";

  // A sibling describe does not inherit the block above's beforeEach, so this
  // one arms every delegate the route touches with all sections on.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({
      id: "singleton",
      // ON, so the uploadedAssetReferences block is built too — one more place
      // a whole gear row could be copied into the payload.
      includeUploadsInBackup: true,
      defaultCurrency: "USD",
    });
    mocks.firearmFindMany.mockResolvedValue([
      { id: "f1", name: "Duty Rifle", manufacturer: "Acme", serialNumber: "FIREARM-SERIAL-1" },
    ]);
    mocks.accessoryFindMany.mockResolvedValue([
      { id: "a1", name: "Optic", manufacturer: "DotCo", serialNumber: "ACCESSORY-SERIAL-1" },
    ]);
    mocks.buildFindMany.mockResolvedValue([
      {
        id: "b1",
        name: "Patrol Build",
        firearmId: "f1",
        slots: [
          {
            id: "s1",
            buildId: "b1",
            slotType: "OPTIC",
            accessoryId: "a1",
            accessory: { id: "a1", name: "Optic", serialNumber: "ACCESSORY-SERIAL-1" },
          },
        ],
      },
    ]);
    mocks.ammoStockFindMany.mockResolvedValue([
      { id: "am1", caliber: "5.56", brand: "Federal", quantity: 300, transactions: [] },
    ]);
    // A kit line pointing at a firearm that carries a serial: the exact nested
    // shape build slots leaked through, one table further out. The label-only
    // line is here so the strip is proved not to depend on a relation being
    // present, and the ammo line so a source with no serial column is walked
    // too.
    mocks.kitFindMany.mockResolvedValue([
      {
        id: "kit-bugout",
        name: "Bugout Bag",
        category: "BUGOUT",
        location: "Hall closet",
        items: [
          {
            id: "kit-line-firearm",
            kitId: "kit-bugout",
            firearmId: "f-kit",
            quantity: 1,
            firearm: {
              id: "f-kit",
              name: "Truck Gun",
              manufacturer: "Acme",
              model: "M4",
              caliber: "5.56",
              type: "RIFLE",
              serialNumber: KIT_FIREARM_SENTINEL,
            },
          },
          {
            id: "kit-line-ammo",
            kitId: "kit-bugout",
            ammoStockId: "am1",
            quantity: 60,
            ammoStock: { id: "am1", brand: "Federal", caliber: "5.56", quantity: 300 },
          },
          {
            id: "kit-line-label",
            kitId: "kit-bugout",
            label: "Spare bootlaces",
            quantity: 2,
          },
        ],
      },
    ]);
    mocks.rangeSessionFindMany.mockResolvedValue([
      { id: "rs1", sessionDate: new Date("2026-05-01T00:00:00.000Z"), sessionDrills: [], ammoLinks: [] },
    ]);

    mocks.gearFindMany.mockResolvedValue([
      {
        id: "g-armor",
        name: "Front Plate",
        manufacturer: "PlateCo",
        category: "ARMOR",
        protectionLevel: "NIJ III+",
        armorSize: "Medium SAPI",
        expirationDate: new Date("2026-01-01T00:00:00.000Z"),
        imageUrl: "/api/files/images/gear/g-armor.jpg",
        serialNumber: GEAR_SENTINEL,
      },
    ]);

    mocks.documentFindMany.mockResolvedValue([
      {
        id: "doc-1",
        type: "RECEIPT",
        name: "Plate Receipt",
        gearId: "g-armor",
        fileUrl: "/api/files/documents/doc-1.jpg",
        // The relation as the route's own `select` returns it: id and name,
        // no serial. The select is asserted separately below, because a mock
        // cannot prove what a real query would have withheld.
        firearm: null,
        accessory: null,
        gear: { id: "g-armor", name: "Front Plate" },
      },
    ]);
  });

  it("puts Gear.serialNumber nowhere in the CSV payload when the toggle is off", async () => {
    const { status, body } = await callExport(`format=csv&${ALL_SECTIONS}`);

    expect(status).toBe(200);
    // The item itself is exported, armor columns and all — only the serial is
    // withheld, so a vacuous "nothing came back" cannot pass this.
    expect(body).toContain("Front Plate");
    expect(body).toContain("NIJ III+");
    expect(body).not.toContain(GEAR_SENTINEL);
  });

  it("puts Gear.serialNumber nowhere in the PDF payload either", async () => {
    // The PDF renderer walks the same payload with its own summarizer, so it
    // is a second, independent chance to print a field the CSV dropped.
    const { status, body } = await callExport(`format=pdf&${ALL_SECTIONS}`);

    expect(status).toBe(200);
    expect(body).toContain("Front Plate");
    expect(body).not.toContain(GEAR_SENTINEL);
  });

  it("does emit the sentinel once serials are requested, in both formats", async () => {
    // The control that makes the two assertions above mean something: if the
    // gear row were silently missing, or the sentinel misspelled, this fails.
    const csv = await callExport(`format=csv&${ALL_SECTIONS}&includeSerialNumbers=true`);
    expect(csv.body).toContain(GEAR_SENTINEL);

    const pdf = await callExport(`format=pdf&${ALL_SECTIONS}&includeSerialNumbers=true`);
    expect(pdf.body).toContain(GEAR_SENTINEL);
  });

  it("puts a kit line's firearm serial nowhere in the CSV payload when the toggle is off", async () => {
    const { status, body } = await callExport(`format=csv&${ALL_SECTIONS}`);

    expect(status).toBe(200);
    // The kit and the line are still exported, the firearm's name and all —
    // only the serial is withheld, so a vacuous "nothing came back" cannot
    // pass this.
    expect(body).toContain("Bugout Bag");
    expect(body).toContain("Truck Gun");
    expect(body).toContain("Spare bootlaces");
    expect(body).not.toContain(KIT_FIREARM_SENTINEL);
  });

  it("puts a kit line's firearm serial nowhere in the PDF payload either", async () => {
    // The PDF summarizer collapses `items` to "3 items" rather than printing
    // the nested rows, so this is a weaker guard than the CSV one above by
    // construction. It is here anyway: the sweep's rule is that the sentinel
    // appears NOWHERE in a rendered payload, and a renderer that starts
    // expanding kit lines must not be the first place anyone notices.
    const { status, body } = await callExport(`format=pdf&${ALL_SECTIONS}`);

    expect(status).toBe(200);
    expect(body).toContain("Bugout Bag");
    expect(body).not.toContain(KIT_FIREARM_SENTINEL);
  });

  it("does emit the kit line's serial once serials are requested", async () => {
    // The control for the two above: if the kit row were silently missing, or
    // the sentinel misspelled, this fails.
    const csv = await callExport(`format=csv&${ALL_SECTIONS}&includeSerialNumbers=true`);
    expect(csv.body).toContain(KIT_FIREARM_SENTINEL);
  });

  it("never asks the database for a serial on a kit line's relations", async () => {
    // The nesting path a mock cannot police, the same argument as the document
    // relations below: the kit query narrows each of the five source relations
    // with an explicit `select`, and `serialNumber` is asked for only when the
    // export includes serials. Widen any of them to `true` and a serial rides
    // along on a path the strip would then be the only thing standing in.
    await callExport(`format=csv&${ALL_SECTIONS}`);

    const include = mocks.kitFindMany.mock.calls[0][0].include.items.include;
    for (const relation of ["gear", "accessory", "firearm"] as const) {
      expect(include[relation].select.serialNumber, relation).toBe(false);
    }
    // Supply and AmmoStock have no serial column at all, so the field must not
    // be named on their selects in either direction.
    for (const relation of ["supply", "ammoStock"] as const) {
      expect(include[relation].select).not.toHaveProperty("serialNumber");
    }

    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({ id: "singleton", includeUploadsInBackup: false });
    mocks.firearmFindMany.mockResolvedValue([]);
    mocks.accessoryFindMany.mockResolvedValue([]);
    mocks.gearFindMany.mockResolvedValue([]);
    mocks.buildFindMany.mockResolvedValue([]);
    mocks.ammoStockFindMany.mockResolvedValue([]);
    mocks.rangeSessionFindMany.mockResolvedValue([]);
    mocks.documentFindMany.mockResolvedValue([]);
    mocks.kitFindMany.mockResolvedValue([]);

    await callExport(`format=csv&${ALL_SECTIONS}&includeSerialNumbers=true`);

    const withSerials = mocks.kitFindMany.mock.calls[0][0].include.items.include;
    for (const relation of ["gear", "accessory", "firearm"] as const) {
      expect(withSerials[relation].select.serialNumber, relation).toBe(true);
    }
  });

  it("never asks the database for a serial on a document's nested gear relation", async () => {
    // The nesting path a mock cannot police: `documents` embeds firearm,
    // accessory and gear rows via `include`. They are safe only because each
    // is narrowed to id+name — widen any of them to `true` and a serial rides
    // along on a path the strip above never visits.
    await callExport(`format=csv&${ALL_SECTIONS}`);

    const include = mocks.documentFindMany.mock.calls[0][0].include;
    for (const relation of ["firearm", "accessory", "gear"] as const) {
      expect(include[relation].select).toEqual({ id: true, name: true });
      expect(include[relation].select).not.toHaveProperty("serialNumber");
    }
  });
});
