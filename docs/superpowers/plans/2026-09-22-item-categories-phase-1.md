# Item Categories Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browsable category sections over the firearms and accessories already in the
database, driven by one registry, with the `nfaClass` / `mgRegistry` / `quantity` columns
the later phases build on.

**Architecture:** A single registry module (`src/lib/categories.ts`) declares every section
as a list of matchers, each carrying a Prisma `where` fragment for queries and an
equivalent in-memory `holds()` predicate for exhaustiveness tests. Section pages are thin
server components that resolve a slug to its section, query with `where`, and hand the rows
to the existing Vault and Accessories client components. The sidebar renders groups from
the same registry with counts from one API route.

**Tech Stack:** Next.js 16.1.6 App Router, Prisma 5.22 (Postgres + SQLite from one base
schema), Tailwind, vitest (`environment: "node"`), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-22-item-categories-design.md`

## Global Constraints

- Legal class wins for placement: a firearm with `nfaClass !== "NONE"` belongs to that
  class's section, never to its platform's section. Every firearm appears in exactly one
  Vault section.
- Catch-all sections are defined by **negation**, never by listing values. The API writes
  `type: "UNSPECIFIED"` (`src/app/api/firearms/route.ts:97`) and custom slot types use the
  `CUSTOM:` prefix (`src/lib/types.ts`, `CUSTOM_SLOT_PREFIX`), so any section defined by an
  allowlist would make those rows invisible.
- `nfaClass` defaults to `"NONE"`. Nothing infers a legal classification from existing data.
- `mgRegistry` is only meaningful when `nfaClass === "MACHINE_GUN"`, and is cleared
  **server-side** on write otherwise.
- Existing `SMG` rows are never reclassified. They stay `nfaClass = "NONE"` and are surfaced
  by a notice only.
- Schema changes are new columns with defaults or nullable columns only. No data migration.
- Both providers get schema changes through `npm run gen:schemas`; never hand-edit
  `prisma/postgres/schema.prisma` or `prisma/sqlite/schema.prisma`.
- Empty sections still appear in the nav with a zero count.
- Accent `#00C2FF`; error `#E53935`; success `#00C853`. Dark-theme tokens
  (`text-vault-text`, `bg-vault-surface`, `border-vault-border`, `text-vault-text-muted`).
- Every page checked at 390px width before a task is called done.
- `npm test` and `npm run lint` must pass before each commit. Do not run `npm run build`
  more than once per task; it is slow.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/types.ts` | Modify: add `PDW` type, `NFA_CLASSES`, `MG_REGISTRIES` and their label maps. Single source of truth for all three enums. |
| `src/lib/categories.ts` | **Create:** the section registry — slugs, labels, groups, icons, matchers. |
| `src/lib/categories.test.ts` | **Create:** exhaustiveness and placement invariants. |
| `prisma/schema.base.prisma` | Modify: `Firearm.nfaClass`, `Firearm.mgRegistry`, `Accessory.quantity`. |
| `src/lib/nfa.ts` | **Create:** `normalizeFirearmClassFields()` — the server-side clearing rule. |
| `src/lib/nfa.test.ts` | **Create:** clearing-rule tests. |
| `src/app/api/firearms/route.ts` | Modify: accept and normalize `nfaClass` / `mgRegistry` on POST. |
| `src/app/api/firearms/[id]/route.ts` | Modify: same on PATCH. |
| `src/app/api/accessories/route.ts` | Modify: accept `quantity` on POST. |
| `src/app/api/accessories/[id]/route.ts` | Modify: accept `quantity` on PATCH. |
| `src/app/api/categories/counts/route.ts` | **Create:** one row count per section slug, plus the legacy SMG count. |
| `src/app/vault/VaultClientPage.tsx` | **Create** by extraction: the current body of `src/app/vault/page.tsx`, unchanged behaviour, plus optional `heading` / `initialFirearms` props. |
| `src/app/vault/page.tsx` | Modify: becomes a thin wrapper rendering `VaultClientPage`. |
| `src/app/vault/category/[slug]/page.tsx` | **Create:** one Vault section. |
| `src/app/gear/page.tsx` | **Create:** all accessory-backed gear. |
| `src/app/gear/[slug]/page.tsx` | **Create:** one Gear section. |
| `src/components/layout/Sidebar.tsx` | Modify: Vault and Gear become expandable groups fed by the registry. |
| `src/components/vault/LegacySmgNotice.tsx` | **Create:** the dismissable review notice. |

---

## Task 1: Enums in one place

**Files:**
- Modify: `src/lib/types.ts`
- Test: `src/lib/types.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `FIREARM_TYPES` (now including `"PDW"`), `FirearmType`,
  `FIREARM_TYPE_LABELS`, `NFA_CLASSES`, `NfaClass`, `NFA_CLASS_LABELS`, `MG_REGISTRIES`,
  `MgRegistry`, `MG_REGISTRY_LABELS`, `UNSPECIFIED_FIREARM_TYPE`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/types.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  FIREARM_TYPES,
  FIREARM_TYPE_LABELS,
  MG_REGISTRIES,
  MG_REGISTRY_LABELS,
  NFA_CLASSES,
  NFA_CLASS_LABELS,
  UNSPECIFIED_FIREARM_TYPE,
} from "./types";

describe("firearm enums", () => {
  it("includes PDW as a platform", () => {
    expect(FIREARM_TYPES).toContain("PDW");
  });

  it("keeps SMG as a legacy platform value", () => {
    expect(FIREARM_TYPES).toContain("SMG");
  });

  it("labels every firearm type", () => {
    for (const type of FIREARM_TYPES) {
      expect(FIREARM_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it("names the value the API writes when no type is given", () => {
    expect(UNSPECIFIED_FIREARM_TYPE).toBe("UNSPECIFIED");
    expect(FIREARM_TYPES).not.toContain(UNSPECIFIED_FIREARM_TYPE);
  });
});

describe("nfa enums", () => {
  it("starts at NONE and covers the regulated classes", () => {
    expect(NFA_CLASSES[0]).toBe("NONE");
    expect(NFA_CLASSES).toEqual([
      "NONE",
      "SBR",
      "SBS",
      "MACHINE_GUN",
      "AOW",
      "DESTRUCTIVE_DEVICE",
    ]);
  });

  it("labels every class and every machine gun registry", () => {
    for (const value of NFA_CLASSES) expect(NFA_CLASS_LABELS[value]).toBeTruthy();
    for (const value of MG_REGISTRIES) expect(MG_REGISTRY_LABELS[value]).toBeTruthy();
  });

  it("covers the three machine gun registries", () => {
    expect(MG_REGISTRIES).toEqual(["TRANSFERABLE", "PRE_SAMPLE", "POST_SAMPLE"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/types.test.ts`
Expected: FAIL — `NFA_CLASSES` is not exported.

- [ ] **Step 3: Add the enums**

In `src/lib/types.ts`, add `"PDW"` to `FIREARM_TYPES` after `"PCC"`, add
`PDW: "PDW"` to `FIREARM_TYPE_LABELS`, and append:

```ts
/** The value src/app/api/firearms/route.ts writes when no type is supplied.
 *  Deliberately NOT in FIREARM_TYPES — it is not a platform a user can pick. */
export const UNSPECIFIED_FIREARM_TYPE = "UNSPECIFIED";

// ─── NFA Classification ────────────────────────────────────────
// How a firearm is regulated, which is independent of its platform: a
// select-fire pistol, PDW or rifle is all MACHINE_GUN.
export const NFA_CLASSES = [
  "NONE",
  "SBR",
  "SBS",
  "MACHINE_GUN",
  "AOW",
  "DESTRUCTIVE_DEVICE",
] as const;

export type NfaClass = (typeof NFA_CLASSES)[number];

export const NFA_CLASS_LABELS: Record<NfaClass, string> = {
  NONE: "Title I (non-NFA)",
  SBR: "SBR",
  SBS: "SBS",
  MACHINE_GUN: "Machine Gun",
  AOW: "AOW",
  DESTRUCTIVE_DEVICE: "Destructive Device",
};

export const DEFAULT_NFA_CLASS: NfaClass = "NONE";

// Only meaningful when nfaClass === "MACHINE_GUN".
export const MG_REGISTRIES = ["TRANSFERABLE", "PRE_SAMPLE", "POST_SAMPLE"] as const;

export type MgRegistry = (typeof MG_REGISTRIES)[number];

export const MG_REGISTRY_LABELS: Record<MgRegistry, string> = {
  TRANSFERABLE: "Transferable",
  PRE_SAMPLE: "Pre-sample",
  POST_SAMPLE: "Post-sample",
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/types.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/types.test.ts
git commit -m "feat: add PDW platform and NFA classification enums"
```

---

## Task 2: The category registry

**Files:**
- Create: `src/lib/categories.ts`
- Test: `src/lib/categories.test.ts`

**Interfaces:**
- Consumes: `FIREARM_TYPES`, `UNSPECIFIED_FIREARM_TYPE`, `NFA_CLASSES` from Task 1;
  `SLOT_TYPES`, `CUSTOM_SLOT_PREFIX` from `src/lib/types.ts`.
- Produces:
  - `type SectionGroup = "vault" | "gear" | "prep"`
  - `type SectionSource = "firearm" | "accessory"`
  - `type FirearmRow = { type: string; nfaClass: string }`
  - `type AccessoryRow = { type: string }`
  - `type CategorySection = { slug: string; label: string; description: string; group: SectionGroup; icon: string; sources: SectionMatcher[] }`
  - `CATEGORY_SECTIONS: CategorySection[]`
  - `sectionBySlug(slug: string): CategorySection | undefined`
  - `sectionsForGroup(group: SectionGroup): CategorySection[]`
  - `firearmWhereForSection(section): object | null`
  - `accessoryWhereForSection(section): object | null`
  - `vaultSectionForFirearm(row: FirearmRow): CategorySection | undefined`
  - `gearSectionForAccessory(row: AccessoryRow): CategorySection | undefined`

- [ ] **Step 1: Write the failing test**

Create `src/lib/categories.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
  gearSectionForAccessory,
  sectionBySlug,
  sectionsForGroup,
  vaultSectionForFirearm,
} from "./categories";
import {
  CUSTOM_SLOT_PREFIX,
  FIREARM_TYPES,
  NFA_CLASSES,
  SLOT_TYPES,
  UNSPECIFIED_FIREARM_TYPE,
} from "./types";

describe("registry shape", () => {
  it("has unique slugs", () => {
    const slugs = CATEGORY_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses url-safe slugs", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(section.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("gives every section a label, description and icon", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(section.label).toBeTruthy();
      expect(section.description).toBeTruthy();
      expect(section.icon).toBeTruthy();
      expect(section.sources.length).toBeGreaterThan(0);
    }
  });

  it("resolves a slug, and refuses an unknown one", () => {
    expect(sectionBySlug("handguns")?.label).toBe("Handguns");
    expect(sectionBySlug("nope")).toBeUndefined();
  });

  it("groups sections in declaration order", () => {
    expect(sectionsForGroup("vault").map((s) => s.slug)).toEqual([
      "handguns",
      "rifles",
      "shotguns",
      "other-firearms",
      "sbr",
      "sbs",
      "machine-guns",
      "aow",
      "destructive-devices",
    ]);
    expect(sectionsForGroup("gear").map((s) => s.slug)).toEqual([
      "optics",
      "suppressors",
      "barrels",
      "lowers",
      "magazines",
      "parts",
    ]);
  });
});

describe("firearm placement", () => {
  it("places every platform with no class in exactly one vault section", () => {
    const platforms = [...FIREARM_TYPES, UNSPECIFIED_FIREARM_TYPE, "ZZ_MADE_UP"];
    for (const type of platforms) {
      const matches = sectionsForGroup("vault").filter((section) =>
        section.sources.some(
          (source) => source.source === "firearm" && source.holds({ type, nfaClass: "NONE" }),
        ),
      );
      expect(matches.map((m) => m.slug), `type ${type}`).toHaveLength(1);
    }
  });

  it("places every class in exactly one vault section, whatever the platform", () => {
    for (const nfaClass of NFA_CLASSES) {
      for (const type of FIREARM_TYPES) {
        const matches = sectionsForGroup("vault").filter((section) =>
          section.sources.some(
            (source) => source.source === "firearm" && source.holds({ type, nfaClass }),
          ),
        );
        expect(matches, `${type} / ${nfaClass}`).toHaveLength(1);
      }
    }
  });

  it("sends a select-fire PDW to machine guns, not to a platform section", () => {
    expect(vaultSectionForFirearm({ type: "PDW", nfaClass: "MACHINE_GUN" })?.slug).toBe(
      "machine-guns",
    );
    expect(vaultSectionForFirearm({ type: "PDW", nfaClass: "NONE" })?.slug).toBe(
      "other-firearms",
    );
  });

  it("groups the platforms the way the spec says", () => {
    expect(vaultSectionForFirearm({ type: "PISTOL", nfaClass: "NONE" })?.slug).toBe("handguns");
    expect(vaultSectionForFirearm({ type: "REVOLVER", nfaClass: "NONE" })?.slug).toBe("handguns");
    expect(vaultSectionForFirearm({ type: "RIFLE", nfaClass: "NONE" })?.slug).toBe("rifles");
    expect(vaultSectionForFirearm({ type: "PCC", nfaClass: "NONE" })?.slug).toBe("rifles");
    expect(vaultSectionForFirearm({ type: "BOLT_ACTION", nfaClass: "NONE" })?.slug).toBe("rifles");
    expect(vaultSectionForFirearm({ type: "LEVER_ACTION", nfaClass: "NONE" })?.slug).toBe("rifles");
    expect(vaultSectionForFirearm({ type: "SHOTGUN", nfaClass: "NONE" })?.slug).toBe("shotguns");
    expect(vaultSectionForFirearm({ type: "SMG", nfaClass: "NONE" })?.slug).toBe("other-firearms");
  });

  it("never loses a firearm whose type was never set", () => {
    expect(
      vaultSectionForFirearm({ type: UNSPECIFIED_FIREARM_TYPE, nfaClass: "NONE" })?.slug,
    ).toBe("other-firearms");
  });
});

describe("accessory placement", () => {
  it("places every slot type in exactly one gear section", () => {
    const types = [...SLOT_TYPES, `${CUSTOM_SLOT_PREFIX}Cheek Riser`, "ZZ_MADE_UP"];
    for (const type of types) {
      const matches = sectionsForGroup("gear").filter((section) =>
        section.sources.some(
          (source) => source.source === "accessory" && source.holds({ type }),
        ),
      );
      expect(matches.map((m) => m.slug), `type ${type}`).toHaveLength(1);
    }
  });

  it("groups the accessory types the way the spec says", () => {
    expect(gearSectionForAccessory({ type: "OPTIC" })?.slug).toBe("optics");
    expect(gearSectionForAccessory({ type: "OPTIC_MOUNT" })?.slug).toBe("optics");
    expect(gearSectionForAccessory({ type: "SUPPRESSOR" })?.slug).toBe("suppressors");
    expect(gearSectionForAccessory({ type: "BARREL" })?.slug).toBe("barrels");
    expect(gearSectionForAccessory({ type: "LOWER_RECEIVER" })?.slug).toBe("lowers");
    expect(gearSectionForAccessory({ type: "UPPER_RECEIVER" })?.slug).toBe("lowers");
    expect(gearSectionForAccessory({ type: "MAGAZINE" })?.slug).toBe("magazines");
    expect(gearSectionForAccessory({ type: "TRIGGER" })?.slug).toBe("parts");
    expect(gearSectionForAccessory({ type: `${CUSTOM_SLOT_PREFIX}Cheek Riser` })?.slug).toBe(
      "parts",
    );
  });
});

describe("where fragments agree with holds", () => {
  const inWhere = (where: Record<string, unknown>, value: string): boolean => {
    const clause = where.type as { in?: string[]; notIn?: string[] } | undefined;
    if (clause?.in) return clause.in.includes(value);
    if (clause?.notIn) return !clause.notIn.includes(value);
    return where.type === value;
  };

  it("selects the same firearms as holds, for every platform", () => {
    for (const section of sectionsForGroup("vault")) {
      const where = firearmWhereForSection(section) as Record<string, unknown> | null;
      if (!where) continue;
      for (const type of [...FIREARM_TYPES, UNSPECIFIED_FIREARM_TYPE]) {
        const row = { type, nfaClass: (where.nfaClass as string) ?? "NONE" };
        const byWhere =
          (where.nfaClass === undefined || where.nfaClass === row.nfaClass) &&
          (where.type === undefined || inWhere(where, type));
        const byHolds = section.sources.some(
          (source) => source.source === "firearm" && source.holds(row),
        );
        expect(byWhere, `${section.slug} / ${type}`).toBe(byHolds);
      }
    }
  });

  it("selects the same accessories as holds, for every slot type", () => {
    for (const section of sectionsForGroup("gear")) {
      const where = accessoryWhereForSection(section) as Record<string, unknown> | null;
      if (!where) continue;
      for (const type of SLOT_TYPES) {
        const byWhere = where.type === undefined || inWhere(where, type);
        const byHolds = section.sources.some(
          (source) => source.source === "accessory" && source.holds({ type }),
        );
        expect(byWhere, `${section.slug} / ${type}`).toBe(byHolds);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/categories.test.ts`
Expected: FAIL — cannot resolve `./categories`.

- [ ] **Step 3: Write the registry**

Create `src/lib/categories.ts`:

```ts
import { CUSTOM_SLOT_PREFIX } from "./types";

export type SectionGroup = "vault" | "gear" | "prep";
export type SectionSource = "firearm" | "accessory";

export type FirearmRow = { type: string; nfaClass: string };
export type AccessoryRow = { type: string };

export type SectionMatcher =
  | { source: "firearm"; where: object; holds: (row: FirearmRow) => boolean }
  | { source: "accessory"; where: object; holds: (row: AccessoryRow) => boolean };

export type CategorySection = {
  slug: string;
  label: string;
  description: string;
  group: SectionGroup;
  /** lucide-react icon name, resolved by the nav and the page headers. */
  icon: string;
  sources: SectionMatcher[];
};

// Platform groupings. Catch-all sections are defined by NOT being in these
// lists, so a type nobody planned for — "UNSPECIFIED" from the firearms API, or
// anything added later — still lands somewhere visible.
const HANDGUN_TYPES = ["PISTOL", "REVOLVER"];
const RIFLE_TYPES = ["RIFLE", "BOLT_ACTION", "LEVER_ACTION", "PCC"];
const SHOTGUN_TYPES = ["SHOTGUN"];
const GROUPED_PLATFORMS = [...HANDGUN_TYPES, ...RIFLE_TYPES, ...SHOTGUN_TYPES];

const OPTIC_TYPES = ["OPTIC", "OPTIC_MOUNT"];
const SUPPRESSOR_TYPES = ["SUPPRESSOR"];
const BARREL_TYPES = ["BARREL"];
const RECEIVER_TYPES = ["LOWER_RECEIVER", "UPPER_RECEIVER"];
const MAGAZINE_TYPES = ["MAGAZINE"];
const GROUPED_ACCESSORIES = [
  ...OPTIC_TYPES,
  ...SUPPRESSOR_TYPES,
  ...BARREL_TYPES,
  ...RECEIVER_TYPES,
  ...MAGAZINE_TYPES,
];

/** A Title I firearm on one of the listed platforms. */
function platformSection(types: string[]): SectionMatcher {
  return {
    source: "firearm",
    where: { nfaClass: "NONE", type: { in: types } },
    holds: (row) => row.nfaClass === "NONE" && types.includes(row.type),
  };
}

/** Everything Title I that no platform section claimed. */
function otherPlatformsSection(): SectionMatcher {
  return {
    source: "firearm",
    where: { nfaClass: "NONE", type: { notIn: GROUPED_PLATFORMS } },
    holds: (row) => row.nfaClass === "NONE" && !GROUPED_PLATFORMS.includes(row.type),
  };
}

/** Everything of one NFA class, whatever its platform. */
function classSection(nfaClass: string): SectionMatcher {
  return {
    source: "firearm",
    where: { nfaClass },
    holds: (row) => row.nfaClass === nfaClass,
  };
}

function accessorySection(types: string[]): SectionMatcher {
  return {
    source: "accessory",
    where: { type: { in: types } },
    holds: (row) => types.includes(row.type),
  };
}

/** Components, custom slots, and anything unrecognised. */
function partsSection(): SectionMatcher {
  return {
    source: "accessory",
    where: { type: { notIn: GROUPED_ACCESSORIES } },
    holds: (row) => !GROUPED_ACCESSORIES.includes(row.type),
  };
}

export const CATEGORY_SECTIONS: CategorySection[] = [
  {
    slug: "handguns",
    label: "Handguns",
    description: "Pistols & revolvers",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(HANDGUN_TYPES)],
  },
  {
    slug: "rifles",
    label: "Rifles",
    description: "Rifles, PCCs & bolt guns",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(RIFLE_TYPES)],
  },
  {
    slug: "shotguns",
    label: "Shotguns",
    description: "Shotguns",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(SHOTGUN_TYPES)],
  },
  {
    slug: "other-firearms",
    label: "Other",
    description: "Unsorted & other platforms",
    group: "vault",
    icon: "Shield",
    sources: [otherPlatformsSection()],
  },
  {
    slug: "sbr",
    label: "SBR",
    description: "Short-barreled rifles",
    group: "vault",
    icon: "Shield",
    sources: [classSection("SBR")],
  },
  {
    slug: "sbs",
    label: "SBS",
    description: "Short-barreled shotguns",
    group: "vault",
    icon: "Shield",
    sources: [classSection("SBS")],
  },
  {
    slug: "machine-guns",
    label: "Machine Guns",
    description: "Select-fire, any platform",
    group: "vault",
    icon: "Shield",
    sources: [classSection("MACHINE_GUN")],
  },
  {
    slug: "aow",
    label: "AOW",
    description: "Any other weapon",
    group: "vault",
    icon: "Shield",
    sources: [classSection("AOW")],
  },
  {
    slug: "destructive-devices",
    label: "Destructive Devices",
    description: "DD-classified items",
    group: "vault",
    icon: "Shield",
    sources: [classSection("DESTRUCTIVE_DEVICE")],
  },
  {
    slug: "optics",
    label: "Optics",
    description: "Sights & mounts",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(OPTIC_TYPES)],
  },
  {
    slug: "suppressors",
    label: "Suppressors",
    description: "Silencers",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(SUPPRESSOR_TYPES)],
  },
  {
    slug: "barrels",
    label: "Barrels",
    description: "Spare & swap barrels",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(BARREL_TYPES)],
  },
  {
    slug: "lowers",
    label: "Lowers",
    description: "Receivers",
    group: "gear",
    icon: "Layers",
    sources: [accessorySection(RECEIVER_TYPES)],
  },
  {
    slug: "magazines",
    label: "Magazines",
    description: "Mags & drums",
    group: "gear",
    icon: "Layers",
    sources: [accessorySection(MAGAZINE_TYPES)],
  },
  {
    slug: "parts",
    label: "Parts",
    description: "Components & everything else",
    group: "gear",
    icon: "Settings2",
    sources: [partsSection()],
  },
];

export function sectionBySlug(slug: string): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) => section.slug === slug);
}

export function sectionsForGroup(group: SectionGroup): CategorySection[] {
  return CATEGORY_SECTIONS.filter((section) => section.group === group);
}

export function firearmWhereForSection(section: CategorySection): object | null {
  return section.sources.find((source) => source.source === "firearm")?.where ?? null;
}

export function accessoryWhereForSection(section: CategorySection): object | null {
  return section.sources.find((source) => source.source === "accessory")?.where ?? null;
}

export function vaultSectionForFirearm(row: FirearmRow): CategorySection | undefined {
  return sectionsForGroup("vault").find((section) =>
    section.sources.some((source) => source.source === "firearm" && source.holds(row)),
  );
}

export function gearSectionForAccessory(row: AccessoryRow): CategorySection | undefined {
  return sectionsForGroup("gear").find((section) =>
    section.sources.some((source) => source.source === "accessory" && source.holds(row)),
  );
}

/** Exported for the Parts section header copy and for tests. */
export const CUSTOM_ACCESSORY_PREFIX = CUSTOM_SLOT_PREFIX;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/categories.test.ts`
Expected: PASS. If the "where agrees with holds" block fails, the `where` fragment and the
`holds` predicate have drifted — fix the registry, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/categories.ts src/lib/categories.test.ts
git commit -m "feat: add the category section registry with exhaustive placement"
```

---

## Task 3: Schema columns

**Files:**
- Modify: `prisma/schema.base.prisma`
- Test: `npx prisma validate` on both generated schemas (no unit test — this task is schema only)

**Interfaces:**
- Consumes: nothing.
- Produces: `Firearm.nfaClass` (String, default `"NONE"`), `Firearm.mgRegistry` (String?),
  `Accessory.quantity` (Int, default `1`).

- [ ] **Step 1: Add the columns to the base schema**

In `prisma/schema.base.prisma`, inside `model Firearm`, after the `type` field and its
comment, add:

```prisma
  // NfaClass: NONE | SBR | SBS | MACHINE_GUN | AOW | DESTRUCTIVE_DEVICE
  // How the firearm is regulated — independent of `type`. A select-fire
  // pistol, PDW or rifle is all MACHINE_GUN. Defaults to NONE: nothing infers
  // a legal classification from existing data.
  nfaClass        String   @default("NONE")
  // MgRegistry: TRANSFERABLE | PRE_SAMPLE | POST_SAMPLE
  // Only meaningful when nfaClass = MACHINE_GUN; cleared server-side otherwise.
  mgRegistry      String?
```

Inside `model Accessory`, after the `roundCount` block, add:

```prisma
  // One record can stand for several identical items, e.g. 12 magazines.
  // Builds still attach a specific record, so the configurator is unaffected.
  quantity               Int             @default(1)
```

Add `@@index([nfaClass])` to `model Firearm` alongside the existing indexes.

- [ ] **Step 2: Generate both provider schemas and the migration**

```bash
npm run gen:schemas
npx prisma migrate dev --name add_nfa_class_and_accessory_quantity --schema prisma/sqlite/schema.prisma --skip-generate
npm run db:generate
```

Expected: a new directory under `prisma/sqlite/migrations/`, and
`prisma/postgres/schema.prisma` / `prisma/sqlite/schema.prisma` both showing the three new
fields. Never hand-edit the generated schemas.

- [ ] **Step 3: Regenerate the Postgres baseline**

```bash
npm run gen:schemas
bash scripts/check-migration-drift.sh
```

Expected: the drift check passes for both providers. If it reports Postgres drift, follow
the message — the `0_init` baseline is regenerated with `prisma migrate diff --from-empty`,
which the script prints.

- [ ] **Step 4: Verify the whole suite still passes**

Run: `npm test && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/
git commit -m "feat: add nfaClass, mgRegistry and accessory quantity columns"
```

---

## Task 4: The server-side clearing rule

**Files:**
- Create: `src/lib/nfa.ts`
- Test: `src/lib/nfa.test.ts`
- Modify: `src/app/api/firearms/route.ts`, `src/app/api/firearms/[id]/route.ts`

**Interfaces:**
- Consumes: `NFA_CLASSES`, `MG_REGISTRIES`, `DEFAULT_NFA_CLASS` from Task 1.
- Produces:
  `normalizeFirearmClassFields(input: { nfaClass?: unknown; mgRegistry?: unknown }): { nfaClass: NfaClass; mgRegistry: MgRegistry | null }`

- [ ] **Step 1: Write the failing test**

Create `src/lib/nfa.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeFirearmClassFields } from "./nfa";

describe("normalizeFirearmClassFields", () => {
  it("defaults to NONE with no registry", () => {
    expect(normalizeFirearmClassFields({})).toEqual({ nfaClass: "NONE", mgRegistry: null });
  });

  it("keeps a machine gun's registry", () => {
    expect(
      normalizeFirearmClassFields({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" });
  });

  it("clears the registry when the class is not MACHINE_GUN", () => {
    expect(
      normalizeFirearmClassFields({ nfaClass: "SBR", mgRegistry: "TRANSFERABLE" }),
    ).toEqual({ nfaClass: "SBR", mgRegistry: null });
    expect(
      normalizeFirearmClassFields({ nfaClass: "NONE", mgRegistry: "TRANSFERABLE" }),
    ).toEqual({ nfaClass: "NONE", mgRegistry: null });
  });

  it("rejects an unknown class by falling back to NONE", () => {
    expect(normalizeFirearmClassFields({ nfaClass: "MADE_UP" })).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
    });
  });

  it("rejects an unknown registry rather than storing it", () => {
    expect(
      normalizeFirearmClassFields({ nfaClass: "MACHINE_GUN", mgRegistry: "MADE_UP" }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: null });
  });

  it("trims and upper-cases what the client sends", () => {
    expect(
      normalizeFirearmClassFields({ nfaClass: " machine_gun ", mgRegistry: " post_sample " }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: "POST_SAMPLE" });
  });

  it("ignores non-string input", () => {
    expect(normalizeFirearmClassFields({ nfaClass: 7, mgRegistry: {} })).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/nfa.test.ts`
Expected: FAIL — cannot resolve `./nfa`.

- [ ] **Step 3: Write the module**

Create `src/lib/nfa.ts`:

```ts
import {
  DEFAULT_NFA_CLASS,
  MG_REGISTRIES,
  NFA_CLASSES,
  type MgRegistry,
  type NfaClass,
} from "./types";

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase();
  return (allowed as readonly string[]).includes(candidate) ? (candidate as T) : null;
}

/**
 * The single place the class fields are decided, so every write path agrees.
 * A registry only survives on a machine gun: a record must not keep a
 * pre-sample marking after its class changes, however the write arrives.
 */
export function normalizeFirearmClassFields(input: {
  nfaClass?: unknown;
  mgRegistry?: unknown;
}): { nfaClass: NfaClass; mgRegistry: MgRegistry | null } {
  const nfaClass = normalizeEnum<NfaClass>(input.nfaClass, NFA_CLASSES) ?? DEFAULT_NFA_CLASS;
  const mgRegistry =
    nfaClass === "MACHINE_GUN"
      ? normalizeEnum<MgRegistry>(input.mgRegistry, MG_REGISTRIES)
      : null;
  return { nfaClass, mgRegistry };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/nfa.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire it into both write paths**

In `src/app/api/firearms/route.ts`, add `nfaClass` and `mgRegistry` to the destructured
`body` fields, import the helper, and inside `prisma.firearm.create({ data: { ... } })` add
the spread — place it after the `type` line:

```ts
import { normalizeFirearmClassFields } from "@/lib/nfa";

// ... inside POST, after destructuring:
const classFields = normalizeFirearmClassFields({ nfaClass, mgRegistry });

// ... inside data:
        ...classFields,
```

In `src/app/api/firearms/[id]/route.ts`, do the same for the PATCH handler: destructure the
two fields, and include `...normalizeFirearmClassFields({ nfaClass, mgRegistry })` in the
update data **only when either key is present in the body**, so a PATCH that does not
mention them leaves the record alone:

```ts
const touchesClass = "nfaClass" in body || "mgRegistry" in body;
// ... inside the update data object:
        ...(touchesClass
          ? normalizeFirearmClassFields({
              nfaClass: body.nfaClass ?? existing.nfaClass,
              mgRegistry: body.mgRegistry ?? existing.mgRegistry,
            })
          : {}),
```

Read the file first: if the PATCH handler does not already load the existing row, use
`body.nfaClass` and `body.mgRegistry` alone and note it in the task report.

- [ ] **Step 6: Verify nothing else broke**

Run: `npm test && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/nfa.ts src/lib/nfa.test.ts src/app/api/firearms/
git commit -m "feat: accept and normalize firearm class fields on write"
```

---

## Task 5: Accessory quantity on write

**Files:**
- Create: `src/lib/quantity.ts`
- Test: `src/lib/quantity.test.ts`
- Modify: `src/app/api/accessories/route.ts`, `src/app/api/accessories/[id]/route.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normalizeQuantity(value: unknown, fallback?: number): number`

- [ ] **Step 1: Write the failing test**

Create `src/lib/quantity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeQuantity } from "./quantity";

describe("normalizeQuantity", () => {
  it("defaults to 1", () => {
    expect(normalizeQuantity(undefined)).toBe(1);
    expect(normalizeQuantity(null)).toBe(1);
    expect(normalizeQuantity("")).toBe(1);
  });

  it("accepts a positive whole number, as a number or a string", () => {
    expect(normalizeQuantity(12)).toBe(12);
    expect(normalizeQuantity("12")).toBe(12);
  });

  it("floors a fraction — you cannot own half a magazine", () => {
    expect(normalizeQuantity(2.7)).toBe(2);
  });

  it("refuses zero and negatives, falling back", () => {
    expect(normalizeQuantity(0)).toBe(1);
    expect(normalizeQuantity(-3)).toBe(1);
  });

  it("refuses nonsense", () => {
    expect(normalizeQuantity("abc")).toBe(1);
    expect(normalizeQuantity({})).toBe(1);
    expect(normalizeQuantity(Number.NaN)).toBe(1);
    expect(normalizeQuantity(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("honours an explicit fallback, for PATCH keeping the stored value", () => {
    expect(normalizeQuantity(undefined, 9)).toBe(9);
    expect(normalizeQuantity("bad", 9)).toBe(9);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/quantity.test.ts`
Expected: FAIL — cannot resolve `./quantity`.

- [ ] **Step 3: Write the module**

Create `src/lib/quantity.ts`:

```ts
/**
 * How many identical items one record stands for. Always at least 1: a record
 * that exists represents something, and 0 would make an item invisible in
 * counts while still sitting in the list.
 */
export function normalizeQuantity(value: unknown, fallback = 1): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.floor(parsed);
  return whole >= 1 ? whole : fallback;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/quantity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire it into both accessory write paths**

In `src/app/api/accessories/route.ts` POST: destructure `quantity` from the body, import
`normalizeQuantity`, and add `quantity: normalizeQuantity(quantity)` to the `create` data.

In `src/app/api/accessories/[id]/route.ts` PATCH: include
`...("quantity" in body ? { quantity: normalizeQuantity(body.quantity) } : {})` in the
update data, so a PATCH that does not mention quantity leaves it alone.

- [ ] **Step 6: Verify**

Run: `npm test && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/quantity.ts src/lib/quantity.test.ts src/app/api/accessories/
git commit -m "feat: accept accessory quantity on write"
```

---

## Task 6: Section counts API

**Files:**
- Create: `src/app/api/categories/counts/route.ts`
- Test: `src/app/api/categories/counts/route.test.ts`

**Interfaces:**
- Consumes: `CATEGORY_SECTIONS`, `firearmWhereForSection`, `accessoryWhereForSection` from
  Task 2.
- Produces: `GET /api/categories/counts` →
  `{ counts: Record<string, number>, legacySmgCount: number }`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/categories/counts/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const firearmCount = vi.fn();
const accessoryCount = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: { count: (args: unknown) => firearmCount(args) },
    accessory: { count: (args: unknown) => accessoryCount(args) },
  },
}));

import { GET } from "./route";

describe("GET /api/categories/counts", () => {
  beforeEach(() => {
    firearmCount.mockReset().mockResolvedValue(3);
    accessoryCount.mockReset().mockResolvedValue(5);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns a count for every section slug", async () => {
    const body = await (await GET()).json();
    const { CATEGORY_SECTIONS } = await import("@/lib/categories");
    for (const section of CATEGORY_SECTIONS) {
      expect(body.counts[section.slug]).toBeTypeOf("number");
    }
  });

  it("counts firearms for vault sections and accessories for gear sections", async () => {
    const body = await (await GET()).json();
    expect(body.counts.handguns).toBe(3);
    expect(body.counts.optics).toBe(5);
  });

  it("reports the legacy SMG count separately", async () => {
    firearmCount.mockImplementation((args: { where?: { type?: string } }) =>
      Promise.resolve(args?.where?.type === "SMG" ? 2 : 3),
    );
    const body = await (await GET()).json();
    expect(body.legacySmgCount).toBe(2);
  });

  it("answers 503 rather than throwing when the database is down", async () => {
    firearmCount.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/categories/counts/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write the route**

Create `src/app/api/categories/counts/route.ts`:

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
} from "@/lib/categories";

// Counts change with every write, so never prerender or cache this.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const entries = await Promise.all(
      CATEGORY_SECTIONS.map(async (section) => {
        const firearmWhere = firearmWhereForSection(section);
        const accessoryWhere = accessoryWhereForSection(section);
        let total = 0;
        if (firearmWhere) total += await prisma.firearm.count({ where: firearmWhere });
        if (accessoryWhere) total += await prisma.accessory.count({ where: accessoryWhere });
        return [section.slug, total] as const;
      }),
    );

    // Surfaced by the Machine Guns notice: rows on the legacy SMG platform that
    // nobody has classified yet. Counted, never reclassified.
    const legacySmgCount = await prisma.firearm.count({
      where: { type: "SMG", nfaClass: "NONE" },
    });

    return NextResponse.json({ counts: Object.fromEntries(entries), legacySmgCount });
  } catch (error) {
    console.error("[categories/counts] failed:", error);
    // 503 so the outage notice in DatabaseStatusProvider recognises it.
    return NextResponse.json({ error: "counts unavailable" }, { status: 503 });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/api/categories/counts/route.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/categories/
git commit -m "feat: add section counts endpoint"
```

---

## Task 7: Extract VaultClientPage

**Files:**
- Create: `src/app/vault/VaultClientPage.tsx`
- Modify: `src/app/vault/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VaultClientPage` — a client component accepting
  `{ heading?: string; subheading?: string; sectionSlug?: string }`. With no props it
  behaves exactly as today's `/vault`.

This is a **pure refactor**: no behaviour changes, no new features. It exists so the
section pages reuse one card grid instead of a second copy.

- [ ] **Step 1: Read the whole current page**

Run: `sed -n 1,530p src/app/vault/page.tsx`

Note every local component defined in it (there is a firearm card and a build-edit block)
and that it fetches `/api/firearms` in a `useEffect`.

- [ ] **Step 2: Move the file**

```bash
git mv src/app/vault/page.tsx src/app/vault/VaultClientPage.tsx
```

- [ ] **Step 3: Rename the export and add the props**

In `src/app/vault/VaultClientPage.tsx`, change the default export function to a named
export and give it the optional props:

```tsx
export function VaultClientPage({
  heading = "VAULT",
  subheading,
  sectionSlug,
}: {
  heading?: string;
  subheading?: string;
  sectionSlug?: string;
}) {
```

Replace the hardcoded page title with `heading`, and where the count line renders
(`{n} firearms in inventory`), use `subheading ?? \`${filtered.length} firearms in inventory\``.

Change the fetch so a section page loads only its own rows:

```tsx
  useEffect(() => {
    const url = sectionSlug ? `/api/firearms?section=${sectionSlug}` : "/api/firearms";
    fetch(url)
```

Replace the file's local `FIREARM_TYPES`, `FIREARM_TYPE_LABELS` and `TYPE_BADGE_COLORS`
copies with imports from `@/lib/types`, adding a local `ALL` entry for the filter row:

```tsx
import { FIREARM_TYPES, FIREARM_TYPE_LABELS } from "@/lib/types";

const FILTER_TYPES = ["ALL", ...FIREARM_TYPES] as const;
const FILTER_LABELS: Record<string, string> = { ALL: "All", ...FIREARM_TYPE_LABELS };
```

Keep `TYPE_BADGE_COLORS` local — it is presentation, not domain — and add a `PDW` entry:

```tsx
  PDW: "border-[#7E57C2]/40 text-[#B39DDB]",
```

- [ ] **Step 4: Create the thin page**

Create `src/app/vault/page.tsx`:

```tsx
import { VaultClientPage } from "./VaultClientPage";

export default function VaultPage() {
  return <VaultClientPage />;
}
```

- [ ] **Step 5: Support the section filter in the firearms API**

In `src/app/api/firearms/route.ts` GET, read the query parameter and apply the section's
`where`:

```ts
import { firearmWhereForSection, sectionBySlug } from "@/lib/categories";

// inside GET(request: NextRequest):
  const slug = request.nextUrl.searchParams.get("section");
  const section = slug ? sectionBySlug(slug) : undefined;
  const where = section ? (firearmWhereForSection(section) ?? undefined) : undefined;
```

Pass `where` into the existing `prisma.firearm.findMany({ ... })` call. An unknown slug
falls through to no filter rather than erroring — the page-level 404 is what handles a bad
slug, and a GET should not fail on a stray parameter.

If `GET` currently takes no argument, change its signature to
`export async function GET(request: NextRequest)`.

- [ ] **Step 6: Verify nothing changed for the user**

```bash
npm test && npm run lint && npm run build
```

Expected: PASS, 0 lint errors, build succeeds. Then start the dev server and confirm
`/vault` looks and behaves exactly as before — filter chips, edit mode, delete, round
counts — at desktop width and at 390px.

- [ ] **Step 7: Commit**

```bash
git add src/app/vault/ src/app/api/firearms/route.ts
git commit -m "refactor: extract VaultClientPage so sections can reuse the card grid"
```

---

## Task 8: Vault section pages

**Files:**
- Create: `src/app/vault/category/[slug]/page.tsx`
- Create: `src/components/vault/LegacySmgNotice.tsx`

**Interfaces:**
- Consumes: `sectionBySlug`, `sectionsForGroup` (Task 2); `VaultClientPage` (Task 7);
  `GET /api/categories/counts` (Task 6).
- Produces: the route `/vault/category/[slug]`.

- [ ] **Step 1: Write the legacy notice component**

Create `src/components/vault/LegacySmgNotice.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info, X } from "lucide-react";

const DISMISS_KEY = "bv-legacy-smg-notice-dismissed";

/**
 * Surfaces firearms still on the legacy SMG platform. It counts them and links
 * to them; it never reclassifies anything, because whether a given gun is
 * select-fire is not something the data can say.
 */
export function LegacySmgNotice() {
  const [count, setCount] = useState(0);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }

    let cancelled = false;
    fetch("/api/categories/counts")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setCount(body.legacySmgCount ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || count === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // A browser that refuses storage still gets the dismissal for this view.
    }
  };

  return (
    <div className="mb-4 flex items-start gap-3 rounded-md border border-[#F5A623]/40 bg-[#F5A623]/10 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-[#F5A623]" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm text-vault-text">
        <p>
          {count} {count === 1 ? "firearm uses" : "firearms use"} the old SMG type and
          {count === 1 ? " has" : " have"} no class set yet.
        </p>
        <Link href="/vault/category/other-firearms" className="text-[#00C2FF] hover:underline">
          Review {count === 1 ? "it" : "them"}
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="shrink-0 text-vault-text-muted hover:text-vault-text"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write the section page**

Create `src/app/vault/category/[slug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { VaultClientPage } from "../../VaultClientPage";
import { LegacySmgNotice } from "@/components/vault/LegacySmgNotice";
import { sectionBySlug } from "@/lib/categories";

export default async function VaultSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "vault") notFound();

  return (
    <>
      {section.slug === "machine-guns" && (
        <div className="px-4 pt-4 sm:px-6">
          <LegacySmgNotice />
        </div>
      )}
      <VaultClientPage
        heading={section.label.toUpperCase()}
        subheading={section.description}
        sectionSlug={section.slug}
      />
    </>
  );
}
```

`params` is awaited because this project is on Next 16, where it is a promise.

- [ ] **Step 3: Verify in a browser**

```bash
npm run dev
```

Check, at desktop width and 390px:
- `/vault/category/handguns` lists only pistols and revolvers.
- `/vault/category/machine-guns` is empty and says so, with the SMG notice above it if any
  SMG rows exist.
- `/vault/category/nonsense` returns the 404 page.
- `/vault` still lists everything.

- [ ] **Step 4: Verify the suite**

Run: `npm test && npm run lint`
Expected: PASS, 0 lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/vault/category/ src/components/vault/
git commit -m "feat: add vault category section pages and the legacy SMG notice"
```

---

## Task 9: Gear section pages

**Files:**
- Create: `src/app/gear/page.tsx`
- Create: `src/app/gear/[slug]/page.tsx`

**Interfaces:**
- Consumes: `sectionBySlug`, `sectionsForGroup`, `accessoryWhereForSection` (Task 2); the
  existing `AccessoriesClientPage` (`src/app/accessories/AccessoriesClientPage.tsx`).
- Produces: the routes `/gear` and `/gear/[slug]`.

- [ ] **Step 1: Read the accessories page to copy its shape**

Run: `cat src/app/accessories/page.tsx src/app/accessories/AccessoriesClientPage.tsx | head -80`

Note the `getAccessories()` query, its `include` of `buildSlots`, the `currentBuild`
mapping, and the try/catch retry UI. The gear pages reuse all of it.

- [ ] **Step 2: Write a shared loader and the section page**

Create `src/app/gear/[slug]/page.tsx`:

```tsx
export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AccessoriesClientPage } from "@/app/accessories/AccessoriesClientPage";
import { accessoryWhereForSection, sectionBySlug } from "@/lib/categories";

async function getSectionAccessories(where: object | undefined) {
  const accessories = await prisma.accessory.findMany({
    where,
    include: {
      buildSlots: {
        include: {
          build: {
            select: {
              id: true,
              name: true,
              isActive: true,
              firearm: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { roundCount: "desc" },
  });

  return accessories.map((accessory) => {
    const activeSlot = accessory.buildSlots.find((slot) => slot.build.isActive);
    return {
      ...accessory,
      currentBuild: activeSlot
        ? {
            id: activeSlot.build.id,
            name: activeSlot.build.name,
            slotType: activeSlot.slotType,
            firearm: activeSlot.build.firearm,
          }
        : null,
    };
  });
}

export default async function GearSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "gear") notFound();

  let accessories: Awaited<ReturnType<typeof getSectionAccessories>>;
  try {
    accessories = await getSectionAccessories(accessoryWhereForSection(section) ?? undefined);
  } catch {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-vault-text-muted">Failed to load {section.label}.</p>
        <Link href={`/gear/${section.slug}`} className="text-sm text-[#00C2FF] hover:underline">
          Tap to retry
        </Link>
      </div>
    );
  }

  return (
    <AccessoriesClientPage
      accessories={accessories}
      heading={section.label}
      subheading={section.description}
    />
  );
}
```

- [ ] **Step 3: Add the optional heading props to AccessoriesClientPage**

Open `src/app/accessories/AccessoriesClientPage.tsx` and add optional `heading` and
`subheading` props, defaulting to whatever it renders today, so `/accessories` is unchanged:

```tsx
export function AccessoriesClientPage({
  accessories,
  heading = "ACCESSORIES",
  subheading,
}: {
  accessories: AccessoryWithBuild[];
  heading?: string;
  subheading?: string;
}) {
```

Use `heading` where the title renders and `subheading ?? <existing count line>` for the
line beneath it. Read the file before editing: match the prop type name it already uses
rather than inventing `AccessoryWithBuild` if it differs.

- [ ] **Step 4: Write the gear index page**

Create `src/app/gear/page.tsx`:

```tsx
import Link from "next/link";
import { PageHeader } from "@/components/shared/PageHeader";
import { sectionsForGroup } from "@/lib/categories";

export default function GearPage() {
  const sections = sectionsForGroup("gear");

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader title="GEAR" subtitle="Everything that is not a firearm" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <Link
            key={section.slug}
            href={`/gear/${section.slug}`}
            className="rounded-lg border border-vault-border bg-vault-surface p-4 transition-colors hover:border-[#00C2FF]/40"
          >
            <p className="font-medium text-vault-text">{section.label}</p>
            <p className="mt-1 text-xs text-vault-text-muted">{section.description}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
```

Read `src/components/shared/PageHeader.tsx` first and match its actual prop names; if they
differ from `title` / `subtitle`, use the real ones.

- [ ] **Step 5: Verify in a browser**

Check at desktop and 390px:
- `/gear` lists six cards.
- `/gear/optics` shows only optics and mounts; `/gear/parts` shows components, including
  any `CUSTOM:` slot types.
- `/gear/nonsense` 404s.
- `/accessories` is unchanged.

- [ ] **Step 6: Verify the suite**

Run: `npm test && npm run lint && npm run build`
Expected: PASS, 0 lint errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/gear/ src/app/accessories/AccessoriesClientPage.tsx
git commit -m "feat: add gear index and gear section pages"
```

---

## Task 10: Sidebar groups

**Files:**
- Modify: `src/components/layout/Sidebar.tsx`

**Interfaces:**
- Consumes: `sectionsForGroup` (Task 2); `GET /api/categories/counts` (Task 6).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Read the existing Range group**

Run: `sed -n 120,160p src/components/layout/Sidebar.tsx`

The Vault and Gear groups copy this pattern exactly: a button that toggles open state, an
active-route highlight, and an indented child list that is hidden when the rail is
collapsed.

- [ ] **Step 2: Add the counts hook**

At the top of the component, add:

```tsx
const [counts, setCounts] = useState<Record<string, number>>({});

useEffect(() => {
  let cancelled = false;
  fetch("/api/categories/counts")
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      if (!cancelled && body?.counts) setCounts(body.counts);
    })
    .catch(() => {
      // A missing count shows as blank; the nav still works.
    });
  return () => {
    cancelled = true;
  };
}, [pathname]);
```

Refetching on `pathname` keeps counts current after an add or delete without a socket.

- [ ] **Step 3: Render the two groups**

Remove `Vault` and `Accessories` from `PRIMARY_NAV_ITEMS`. Add, above the Range group, two
groups built from the registry. Write one reusable local component rather than two copies:

```tsx
function NavGroup({
  label,
  description,
  href,
  icon: Icon,
  group,
  pathname,
  collapsed,
  counts,
  onNavigate,
}: {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  group: "vault" | "gear";
  pathname: string;
  collapsed: boolean;
  counts: Record<string, number>;
  onNavigate?: () => void;
}) {
  const isActive = pathname.startsWith(href);
  const [open, setOpen] = useState(isActive);
  const sectionOpen = isActive || open;
  const sections = sectionsForGroup(group);

  return (
    <div>
      <div className="flex items-center">
        <Link
          href={href}
          onClick={() => onNavigate?.()}
          className={cn(
            "flex flex-1 items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-all duration-150 group relative",
            isActive
              ? "bg-[#00C2FF]/10 text-[#00C2FF] border border-[#00C2FF]/20"
              : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
          )}
          title={collapsed ? label : undefined}
        >
          {isActive && (
            <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-[#00C2FF]" />
          )}
          <Icon
            className={cn(
              "shrink-0 transition-colors",
              collapsed ? "h-5 w-5" : "h-4 w-4",
              isActive ? "text-[#00C2FF]" : "text-vault-text-faint",
            )}
          />
          {!collapsed && (
            <span className="min-w-0 text-left">
              <span className="block truncate font-medium tracking-wide">{label}</span>
              <span className="block truncate text-[11px] text-vault-text-faint">
                {description}
              </span>
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-label={`${sectionOpen ? "Collapse" : "Expand"} ${label} sections`}
            aria-expanded={sectionOpen}
            className="p-2 text-vault-text-faint hover:text-vault-text"
          >
            <ChevronDown
              className={cn("h-4 w-4 transition-transform", sectionOpen ? "rotate-180" : "rotate-0")}
            />
          </button>
        )}
      </div>

      {!collapsed && sectionOpen && (
        <div className="mt-1 ml-4 space-y-0.5 border-l border-vault-border pl-2">
          {sections.map((section) => {
            const sectionHref =
              group === "vault" ? `/vault/category/${section.slug}` : `/gear/${section.slug}`;
            return (
              <Link
                key={section.slug}
                href={sectionHref}
                onClick={() => onNavigate?.()}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                  pathname === sectionHref
                    ? "text-[#00C2FF]"
                    : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                <span className="shrink-0 tabular-nums text-vault-text-faint">
                  {counts[section.slug] ?? ""}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

Import `type LucideIcon` from `lucide-react` and `sectionsForGroup` from `@/lib/categories`.
Render it twice in the nav, where Vault used to sit:

```tsx
<NavGroup
  label="Vault"
  description="Firearms inventory"
  href="/vault"
  icon={Shield}
  group="vault"
  pathname={pathname}
  collapsed={collapsed}
  counts={counts}
  onNavigate={onMobileClose}
/>
<NavGroup
  label="Gear"
  description="Optics, parts & more"
  href="/gear"
  icon={Crosshair}
  group="gear"
  pathname={pathname}
  collapsed={collapsed}
  counts={counts}
  onNavigate={onMobileClose}
/>
```

The group header is a **link plus a separate chevron button**, not one button: tapping the
name should go to the combined page, which is what the spec means by Vault staying the
firearms home.

- [ ] **Step 4: Keep /accessories reachable**

Add it to `BOTTOM_NAV_ITEMS` so the old page is not orphaned:

```tsx
{ label: "Accessories", href: "/accessories", icon: Crosshair, description: "All accessories" },
```

- [ ] **Step 5: Verify in a browser**

Check at desktop and **390px especially** — two expandable groups plus Range is the case
most likely to overflow:
- Vault and Gear expand and collapse; the chevron does not navigate and the label does.
- Counts appear beside each section and change after adding a firearm.
- The collapsed rail shows icons only, with no stray chevrons.
- Tapping a section on mobile closes the drawer.
- The active section is highlighted.

- [ ] **Step 6: Verify the suite**

Run: `npm test && npm run lint && npm run build`
Expected: PASS, 0 lint errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/Sidebar.tsx
git commit -m "feat: vault and gear nav groups with section counts"
```

---

## Task 11: Class fields in the firearm forms

**Files:**
- Modify: `src/app/vault/new/page.tsx`, `src/app/vault/[id]/edit/page.tsx`
- Modify: `src/app/vault/[id]/page.tsx`

**Interfaces:**
- Consumes: `NFA_CLASSES`, `NFA_CLASS_LABELS`, `MG_REGISTRIES`, `MG_REGISTRY_LABELS`,
  `FIREARM_TYPES`, `FIREARM_TYPE_LABELS` (Task 1).
- Produces: nothing other tasks depend on.

The full NFA paperwork group is **phase 3**. This task adds only the class and registry, so
the sections have data to sort by.

- [ ] **Step 1: Read both forms**

Run: `ug -n 'type|select|FIREARM' src/app/vault/new/page.tsx | head -30`

Note how the existing `type` select is built and how the form submits, so the new selects
match it exactly.

- [ ] **Step 2: Add the selects to the create form**

In `src/app/vault/new/page.tsx`, beside the existing `type` select, add a class select and
a registry select that only renders for machine guns. Use the page's existing state
pattern:

```tsx
import { MG_REGISTRIES, MG_REGISTRY_LABELS, NFA_CLASSES, NFA_CLASS_LABELS } from "@/lib/types";

const [nfaClass, setNfaClass] = useState("NONE");
const [mgRegistry, setMgRegistry] = useState("");
```

```tsx
<div>
  <label htmlFor="nfaClass" className="mb-1 block text-xs text-vault-text-muted">
    Classification
  </label>
  <select
    id="nfaClass"
    name="nfaClass"
    value={nfaClass}
    onChange={(event) => setNfaClass(event.target.value)}
    className={SELECT_CLASS}
  >
    {NFA_CLASSES.map((value) => (
      <option key={value} value={value}>
        {NFA_CLASS_LABELS[value]}
      </option>
    ))}
  </select>
  <p className="mt-1 text-[11px] text-vault-text-faint">
    Select-fire is a Machine Gun whatever the platform.
  </p>
</div>

{nfaClass === "MACHINE_GUN" && (
  <div>
    <label htmlFor="mgRegistry" className="mb-1 block text-xs text-vault-text-muted">
      Registry
    </label>
    <select
      id="mgRegistry"
      name="mgRegistry"
      value={mgRegistry}
      onChange={(event) => setMgRegistry(event.target.value)}
      className={SELECT_CLASS}
    >
      <option value="">Not recorded</option>
      {MG_REGISTRIES.map((value) => (
        <option key={value} value={value}>
          {MG_REGISTRY_LABELS[value]}
        </option>
      ))}
    </select>
  </div>
)}
```

`SELECT_CLASS` stands for whatever class string the neighbouring selects already use —
copy it rather than inventing new styling.

Include both in the POST body: `nfaClass, mgRegistry: mgRegistry || null`.

Also add `PDW` to the form's platform options if the form lists types locally rather than
importing `FIREARM_TYPES`; if it does list them locally, replace that list with the import.

- [ ] **Step 3: Add the same selects to the edit form**

Repeat in `src/app/vault/[id]/edit/page.tsx`, initialising from the loaded firearm
(`firearm.nfaClass ?? "NONE"`, `firearm.mgRegistry ?? ""`) and sending both in the PATCH.

- [ ] **Step 4: Show the class on the detail page**

In `src/app/vault/[id]/page.tsx`, beside the existing type badge, render the class when it
is not `NONE`:

```tsx
{firearm.nfaClass && firearm.nfaClass !== "NONE" && (
  <span className="rounded border border-[#F5A623]/40 px-2 py-0.5 text-xs text-[#F5A623]">
    {NFA_CLASS_LABELS[firearm.nfaClass as NfaClass] ?? firearm.nfaClass}
    {firearm.mgRegistry
      ? ` · ${MG_REGISTRY_LABELS[firearm.mgRegistry as MgRegistry] ?? firearm.mgRegistry}`
      : ""}
  </span>
)}
```

- [ ] **Step 5: Verify end to end in a browser**

- Add a firearm as `PDW` + `Machine Gun` + `Pre-sample`; it appears under
  `/vault/category/machine-guns` and **not** under Handguns or Rifles.
- Edit it back to Title I; it moves to `/vault/category/other-firearms` and the registry is
  gone from the record (check the detail page).
- Add a plain pistol; it appears under Handguns.
- Both forms work at 390px.

- [ ] **Step 6: Verify the suite**

Run: `npm test && npm run lint && npm run build`
Expected: PASS, 0 lint errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/app/vault/
git commit -m "feat: set firearm classification from the vault forms"
```

---

## Task 12: Quantity in the accessory forms

**Files:**
- Modify: `src/app/accessories/new/page.tsx`, `src/app/accessories/[id]/edit/page.tsx`
- Modify: `src/app/accessories/AccessoriesClientPage.tsx`

**Interfaces:**
- Consumes: `normalizeQuantity` behaviour from Task 5 (the API already enforces it).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the field to both forms**

A number input beside the existing fields, defaulting to 1:

```tsx
<div>
  <label htmlFor="quantity" className="mb-1 block text-xs text-vault-text-muted">
    Quantity
  </label>
  <input
    id="quantity"
    name="quantity"
    type="number"
    min={1}
    step={1}
    value={quantity}
    onChange={(event) => setQuantity(event.target.value)}
    className={INPUT_CLASS}
  />
  <p className="mt-1 text-[11px] text-vault-text-faint">
    How many identical items this record stands for.
  </p>
</div>
```

`INPUT_CLASS` stands for the class string the neighbouring inputs already use. Send
`quantity` in the POST and PATCH bodies. Initialise the edit form from
`accessory.quantity ?? 1`.

- [ ] **Step 2: Show it in the list**

In `src/app/accessories/AccessoriesClientPage.tsx`, where each row renders its name, append
a quantity marker when it is more than one:

```tsx
{accessory.quantity > 1 && (
  <span className="ml-2 rounded border border-vault-border px-1.5 py-0.5 text-[11px] text-vault-text-muted">
    ×{accessory.quantity}
  </span>
)}
```

- [ ] **Step 3: Verify in a browser**

- Create a magazine with quantity 12; the list shows `×12` and `/gear/magazines` shows it.
- Edit it to 4; the marker updates.
- Submitting an empty or `0` quantity stores 1 rather than failing.
- Both forms work at 390px.

- [ ] **Step 4: Verify the suite**

Run: `npm test && npm run lint && npm run build`
Expected: PASS, 0 lint errors, build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/app/accessories/
git commit -m "feat: set accessory quantity from the accessory forms"
```

---

## Verification before the phase is called done

Run once, on a real container, following the pattern from the health-check work:

```bash
npm test && npm run lint && npm run build
bash scripts/check-migration-drift.sh
```

Then, with the dev server running, at desktop width and at 390px:

1. Every Vault section lists the right firearms, and the counts in the nav match the rows
   on the page.
2. A select-fire PDW sits in Machine Guns only.
3. A firearm with no type set is visible under Other, not missing.
4. Every Gear section lists the right accessories, `CUSTOM:` slot types included, under
   Parts.
5. `/vault` and `/accessories` behave exactly as they did before this phase.
6. A bad slug 404s in both namespaces.
7. Stopping the database shows the outage notice rather than a broken nav.
