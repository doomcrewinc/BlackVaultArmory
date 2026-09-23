# Item Categories — Design

**Date:** 2026-09-22
**Status:** Approved for planning
**Goal:** Browsable top-level sections for everything in the collection — firearms by
platform and legal class, attachable gear, standalone gear, preparedness stores and ammo —
plus kits that record what is packed where, without restructuring the models Builds and
Range depend on.

---

## Why

BlackVault tracks three kinds of thing: firearms, accessories that mount in build slots,
and ammunition. That leaves three gaps:

1. **No home for standalone kit.** A knife or a case is not a firearm, not a build slot
   accessory, and not ammo.
2. **No home for consumable stores** — cleaning supplies, medical, food and water are
   quantities with levels, not serialised items, and most of them expire.
3. **No home for preparedness kit** — armor and bugout gear, nor any record of what is
   packed in which bag.
4. **`Firearm.type` conflates platform with legal class.** A select-fire PDW has nowhere
   to go: `PDW` loses the machine gun status, `MACHINE_GUN` loses the platform. The
   existing `SMG` value is ambiguous for the same reason.

Categories are also not browsable. The user asked for sections you navigate to, not a type
field you filter on.

## Decisions taken

| Question | Decision |
| --- | --- |
| What are categories? | Top-level browsable sections with their own pages and counts |
| Firearm sections vs Vault | Vault stays the combined firearms home; sections nest under it |
| Where does standalone gear live? | New `Gear` model; attachable items stay `Accessory` |
| Consumable stores | One `Supply` model (cleaning, medical, food, water…), manual levels with low-stock alerts |
| Expiry | Optional `expirationDate` on `Supply` and `Gear`, with expired / expiring-soon alerts |
| Armor and bugout kit | `Gear`, under a third nav group; armor gets protection level and size |
| Kits | `Kit` + `KitItem` — a packing list with target quantities, so a kit shows what is missing or expired |
| Identical items | Optional `quantity` on `Accessory` and `Gear` |
| NFA paperwork | Shared nullable field group on `Firearm` and `Accessory` |
| Legal class vs platform | Separate fields; class determines section placement |
| Existing `SMG` rows | Left non-NFA, flagged for review — never auto-classified |

## Data model

### Firearm: split platform from legal class

`type` keeps its existing values and gains `PDW`. It describes **what the firearm is**:

```
PISTOL | REVOLVER | RIFLE | SHOTGUN | PCC | PDW | BOLT_ACTION | LEVER_ACTION | SMG (legacy)
```

`nfaClass` is new and describes **how it is regulated**:

```
NONE | SBR | SBS | MACHINE_GUN | AOW | DESTRUCTIVE_DEVICE
```

Machine gun status follows fire control, not form factor: a select-fire pistol, PDW or
rifle is `nfaClass = MACHINE_GUN` whatever its `type`. The same platform without select
fire is `NONE` and is an ordinary Title I firearm.

`nfaClass` defaults to `NONE`, so every existing firearm stays Title I until the owner
says otherwise. Nothing infers a legal classification from existing data.

`mgRegistry` applies only when `nfaClass = MACHINE_GUN`:

```
TRANSFERABLE | PRE_SAMPLE | POST_SAMPLE
```

Pre- and post-sample guns imply an SOT rather than a private owner; `nfaRegisteredTo`
carries that.

New columns on `Firearm`, all nullable or defaulted:

| Column | Type | Notes |
| --- | --- | --- |
| `nfaClass` | `String` default `"NONE"` | |
| `mgRegistry` | `String?` | Only meaningful when `nfaClass = MACHINE_GUN` |
| NFA field group | see below | |

### NFA field group (Firearm and Accessory)

The same five nullable columns on both models — suppressors are accessories:

| Column | Type | Notes |
| --- | --- | --- |
| `nfaTransferMethod` | `String?` | `FORM_1 \| FORM_3 \| FORM_4 \| FORM_4473 \| OTHER`; null = no paperwork recorded |
| `nfaControlNumber` | `String?` | Control number from the approved stamp |
| `nfaApprovalDate` | `DateTime?` | Date-only semantics, per the date-handling spec |
| `nfaTaxPaid` | `Float?` | |
| `nfaRegisteredTo` | `String?` | Individual, trust or SOT name |

`FORM_4473` exists because SBRs, SBSs and suppressors can transfer on a 4473 rather than
an NFA form. When it is selected there is no stamp, so `nfaControlNumber`,
`nfaApprovalDate` and `nfaTaxPaid` are hidden in the form and not required.

These are inline columns rather than a separate `NfaRecord` table: two consumers, no
shared lifecycle, and Prisma has no polymorphic relations. A cross-model "all NFA items"
view can be added later by querying both models — no migration needed for that.

A suppressor's class is implied by `Accessory.type = SUPPRESSOR`; accessories get no
`nfaClass` column.

### Accessory: quantity

| Column | Type | Notes |
| --- | --- | --- |
| `quantity` | `Int` default `1` | One record can represent 12 identical magazines |

Builds still attach a specific accessory record, so the configurator, round counts and
battery tracking are untouched. Items tracked individually stay at `quantity = 1`.

### Gear: new model for standalone kit

```prisma
model Gear {
  id              String     @id @default(cuid())
  name            String
  manufacturer    String?
  model           String?
  serialNumber    String?
  // GearCategory: KNIFE | CASE | ARMOR | MEDICAL_KIT | WATER_TREATMENT | POWER |
  //               COMMS | LIGHT | FIRE | SHELTER | CLOTHING | TOOL | SANITATION |
  //               CBRN | NAVIGATION | SIGNALING | DOCUMENTS | SAFETY | BUGOUT | OTHER
  category        String
  quantity        Int        @default(1)
  purchasePrice   Float?
  currentValue    Float?
  acquisitionDate DateTime?
  expirationDate  DateTime?
  // Armor only, shown when category = ARMOR
  protectionLevel String?
  armorSize       String?
  storageLocation String?
  notes           String?
  imageUrl        String?
  imageSource     String?
  documents       Document[]
  kitItems        KitItem[]
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([category])
}
```

No build slots, no round count, no battery — a knife does not mount on a rifle. `Document`
gains a nullable `gearId` and matching relation, alongside the existing `firearmId` and
`accessoryId`.

`Gear` is for durable goods, `Supply` for things you consume. That line decides where a new
category goes: a plate carrier is `Gear`, the water in the bag is `Supply`.

`protectionLevel` (NIJ rating, e.g. `IIIA`, `III`, `IV`) and `armorSize` (plate cut or
carrier size) are free text rather than enums — ratings and cuts vary by maker, and a
wrong enum would block a real plate from being recorded.

### Supply: new consumable model

```prisma
model Supply {
  id              String     @id @default(cuid())
  name            String
  brand           String?
  // SupplyCategory: CLEANING | MEDICAL | FOOD | WATER | FILTER | BATTERY | FUEL |
  //                 SANITATION | CBRN_FILTER | SIGNAL | OTHER
  category        String
  quantity        Float      @default(0)
  // SupplyUnit: OZ | ML | COUNT | KIT | LB | GAL | L | CAL
  unit            String
  lowStockAlert   Float?
  expirationDate  DateTime?
  purchasePrice   Float?
  purchaseDate    DateTime?
  storageLocation String?
  notes           String?
  kitItems        KitItem[]
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([category])
  @@index([expirationDate])
}
```

One model covers cleaning, medical, food and water because they are the same shape: a
quantity, a unit, a threshold, and — for most of them — a date after which the stock is
no longer good.

`quantity` is a `Float`, not an `Int` like `AmmoStock.quantity`: solvent comes in fractions
of an ounce and water in fractions of a gallon. Levels are set by hand — nothing deducts
automatically, because guessing how much CLP a cleaning used, or how much rice a meal
took, would make the numbers worse, not better.

A supply is low when `lowStockAlert` is set and `quantity <= lowStockAlert`, matching the
existing ammo low-stock rule. `expirationDate` is date-only, per the date-handling spec.

### Expiry

`Supply` and `Gear` both carry an optional `expirationDate`. Armor plates have a rated
life, medications and food have dates, a knife does not — so the field is optional
everywhere and simply absent from sections where it does not apply.

Categories where expiry is the point, not an afterthought: food, water treatment tablets,
water and CBRN filters, medications, chest seals, batteries, chemlights and flares, fuel
and stabiliser, armor plates, and — outside the bugout world but in the same boat — fire
extinguishers and smoke/CO detectors, which is why `SAFETY` exists as a gear category.

An item is **expired** when the date is in the past and **expiring soon** when it falls
within a window the user sets in Settings, defaulting to 90 days. One fixed window would
be wrong for both milk and body armor, so it is configurable; sections and the dashboard
badge both states.

Expiry is evaluated in the browser's local timezone against a date-only value, so "expires
today" means today where the user is — consistent with the date-handling spec.

### Migration shape

Every change is a new table, a new nullable column, or a new column with a default. No
existing row is rewritten and no data migration runs. Both providers get the change through
`npm run gen:schemas`; the SQLite history gains one migration and the Postgres `0_init` is
regenerated.

### Kit and KitItem: what is packed where

```prisma
model Kit {
  id        String    @id @default(cuid())
  name      String
  // KitCategory: BUGOUT | MEDICAL | RANGE | VEHICLE | HOME | OTHER
  category  String
  location  String?
  notes     String?
  imageUrl  String?
  items     KitItem[]
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  @@index([category])
}

model KitItem {
  id             String      @id @default(cuid())
  kitId          String
  kit            Kit         @relation(fields: [kitId], references: [id], onDelete: Cascade)

  // Exactly one source, or none plus a label. Enforced in the API and by test.
  gearId         String?
  supplyId       String?
  accessoryId    String?
  ammoStockId    String?
  firearmId      String?
  label          String?

  gear           Gear?       @relation(fields: [gearId], references: [id], onDelete: Cascade)
  supply         Supply?     @relation(fields: [supplyId], references: [id], onDelete: Cascade)
  accessory      Accessory?  @relation(fields: [accessoryId], references: [id], onDelete: Cascade)
  ammoStock      AmmoStock?  @relation(fields: [ammoStockId], references: [id], onDelete: Cascade)
  firearm        Firearm?    @relation(fields: [firearmId], references: [id], onDelete: Cascade)

  quantity       Float       @default(1)
  targetQuantity Float?
  notes          String?
  createdAt      DateTime    @default(now())
  updatedAt      DateTime    @updatedAt

  @@index([kitId])
}
```

A kit is a container, not a copy: a `KitItem` points at an inventory record and says how
much of it lives in this kit. A bag can hold gear, supplies, accessories, ammo and a
firearm, because a real bugout bag does.

**Exactly one source, or a label.** A `KitItem` sets one of the five foreign keys, or none
of them plus a `label` for something not tracked as inventory ("spare keys", "cash").
Prisma cannot express that as a constraint portably, so the API rejects violations and a
test covers every shape.

**Allocation, not ownership.** Twelve magazines can be four in the truck bag and eight at
home: two `KitItem` rows against one `Accessory`. Over-allocation — more assigned across
kits than the item's own `quantity` — is **flagged, never blocked**: the item and every kit
holding it show "14 of 12 assigned". Blocking would fight reality while someone is packing;
a silent overdraft would hide a mistake.

**Missing.** `targetQuantity` is what the kit should hold; `quantity` is what is in it. A
kit reports missing items when `targetQuantity > quantity`, which is what makes a packing
list a checklist rather than a snapshot.

**Expiry rollup.** A kit shows the earliest expiry among its contents and a count of
expired and expiring-soon items, so "what is rotten in the truck bag" is answerable from
the kit page rather than by opening each item.

**Deletes cascade from the item.** Deleting an inventory record removes its `KitItem` rows;
a kit does not keep a line pointing at nothing. Deleting a kit removes its lines and
touches no inventory.

## The category registry

One module, `src/lib/categories.ts`, is the single source of truth for every section:

```ts
export type CategorySection = {
  slug: string;              // URL segment, unique across all sections
  label: string;             // "Machine Guns"
  group: "vault" | "gear" | "prep";   // which nav group it sits under
  icon: string;
  // One or more sources: Medical holds the IFAK bag (gear) and the meds in it (supply).
  sources: Array<{
    source: "firearm" | "accessory" | "gear" | "supply" | "kit";
    where: object;             // Prisma where fragment, for queries and counts
    holds: (row) => boolean;   // same rule in memory, for the invariant tests
  }>;
};
```

`where` and `holds` express one rule twice on purpose: the pages query with `where`, and
the tests assert exhaustive placement with `holds` without touching a database. A test
asserts the two agree for every section.

The nav, the section pages, the counts and the dashboard all derive from this list, so
adding a category later is one entry rather than a new page and six edits.

**Placement rule:** legal class wins. A firearm with `nfaClass !== "NONE"` belongs to that
class's section; otherwise it belongs to its platform's section. Every firearm therefore
appears in exactly **one** Vault section, and a test asserts it (see Testing).

### Sections

| Group | Section | Source and filter |
| --- | --- | --- |
| Vault | Handguns | firearm, `nfaClass=NONE`, type in `PISTOL, REVOLVER` |
| Vault | Rifles | firearm, `nfaClass=NONE`, type in `RIFLE, BOLT_ACTION, LEVER_ACTION, PCC` |
| Vault | Shotguns | firearm, `nfaClass=NONE`, type `SHOTGUN` |
| Vault | Other | firearm, `nfaClass=NONE`, type in `PDW, SMG` (legacy) |
| Vault | SBR | firearm, `nfaClass=SBR` |
| Vault | SBS | firearm, `nfaClass=SBS` |
| Vault | Machine Guns | firearm, `nfaClass=MACHINE_GUN` |
| Vault | AOW | firearm, `nfaClass=AOW` |
| Vault | Destructive Devices | firearm, `nfaClass=DESTRUCTIVE_DEVICE` |
| Gear | Optics | accessory, type in `OPTIC, OPTIC_MOUNT` |
| Gear | Suppressors | accessory, type `SUPPRESSOR` |
| Gear | Barrels | accessory, type `BARREL` |
| Gear | Lowers | accessory, type in `LOWER_RECEIVER, UPPER_RECEIVER` |
| Gear | Magazines | accessory, type `MAGAZINE` |
| Gear | Parts | accessory, remaining component types |
| Gear | Knives | gear `KNIFE` |
| Gear | Cases | gear `CASE` |
| Gear | Cleaning | supply `CLEANING` |
| Preparedness | Armor | gear `ARMOR` |
| Preparedness | Medical | gear `MEDICAL_KIT` + supply `MEDICAL` |
| Preparedness | Food & Water | gear `WATER_TREATMENT` + supply `FOOD, WATER, FILTER` |
| Preparedness | Power & Comms | gear `POWER, COMMS` + supply `BATTERY` |
| Preparedness | Shelter & Clothing | gear `SHELTER, CLOTHING` |
| Preparedness | Tools & Fire | gear `TOOL, FIRE, LIGHT, SIGNALING` + supply `FUEL, SIGNAL` |
| Preparedness | Other Prep | gear `SANITATION, CBRN, NAVIGATION, DOCUMENTS, SAFETY, BUGOUT, OTHER` + supply `SANITATION, CBRN_FILTER, OTHER` |
| Preparedness | Kits | kit, all |

"Parts" is a grouping of existing accessory types, not a new type: muzzle devices,
handguards, stocks, buffer tubes, grips, triggers, charging handles, slides, frames,
compensators, bipods, slings, lights, lasers and underbarrel items. Every accessory type
belongs to exactly one Gear section, asserted by the same test. The same holds for every
`GearCategory` and `SupplyCategory` value: exactly one section, so a new category cannot be
added without a home.

Cleaning sits in the Gear group rather than Preparedness — it is gun maintenance, not a
bugout store — even though its rows are `Supply`. Sections are grouped by what the user is
doing, not by which table the data is in.

Ammo keeps its own top-level section and its existing page unchanged; it is listed here
only for completeness. Empty sections still appear in the nav, with a zero count and the existing empty-state
copy. Hiding them would make the collection's shape invisible.

## Routing

`/vault/[id]` already owns the segment after `/vault`, so firearm sections take an extra
segment rather than colliding with a firearm id:

| Path | Page |
| --- | --- |
| `/vault` | unchanged — all firearms |
| `/vault/category/[slug]` | one Vault section |
| `/gear` | all attachable and standalone gear |
| `/gear/[slug]` | one Gear section |
| `/prep` | preparedness overview: armor, medical, food, bugout |
| `/prep/[slug]` | one Preparedness section |
| `/kits` | every kit |
| `/kits/[id]` | one kit: contents, missing, expiring |
| `/cleaning` | cleaning supplies (a `/prep` section by data, kept at its own path) |

`/accessories` keeps working and keeps its URL; `/gear` is a superset view. Existing links
are untouched.

## UI

**Navigation.** Vault and Gear become expandable groups listing their sections with counts.
Range already uses an expandable nav item, so the pattern exists. On mobile the groups
collapse by default to keep the nav short.

**Section pages** reuse the Vault card grid and the Accessories list, with the section's
label and count as the heading. No new card design.

**Firearm form.** `nfaClass` is a select next to `type`. Choosing anything but `NONE`
reveals the NFA field group; choosing `MACHINE_GUN` additionally reveals `mgRegistry`.
Choosing `FORM_4473` as the method hides the three stamp fields. Fields hidden this way
are cleared **server-side on save**, not just in the form, so a record cannot keep a stamp
date it no longer claims however the write arrives: clearing `nfaClass` to `NONE` clears
the whole group and `mgRegistry`, and `FORM_4473` clears the three stamp fields.

**Legacy SMG review.** When any firearm has `type = SMG`, the Machine Guns section shows a
dismissable notice: "N firearms use the old SMG type and have no class set yet" linking to
a filtered list. Nothing is moved or classified automatically. The notice disappears once
no `SMG` rows remain.

**Supply sections** list stores grouped by category with quantity, unit, a LOW badge under
threshold and an EXPIRED / SOON badge by date. The dashboard's existing low-stock area
gains supplies beside ammo, plus expired and expiring-soon counts.

**Kit page** lists contents grouped by source with quantity against target, a missing count,
and expiry badges per line. Adding a line is a picker over existing inventory with a
free-text fallback for untracked things. An over-allocated line shows its warning inline.

**Detail pages** for Gear and CleaningSupply follow the Accessory detail layout, minus the
sections that do not apply.

## Data flow, backup and export

- **Backup/restore.** `Gear` and `CleaningSupply` join `BACKUP_MODELS`. The DMMF test fails
  until they are registered, which is the guard that stops the data-loss bug we fixed from
  returning. Restore must handle a backup written before these models existed: a missing
  key is an empty table, not a failure.
- **Full armory export** gains a Gear section and a Cleaning Supplies section, and the
  firearm rows gain the class and NFA columns.
- **Global search** covers `Gear` and `CleaningSupply` by name, manufacturer/brand and
  notes, using the existing case-insensitive helper.
- **Migration audit.** None needed — no existing data changes.

## Error handling

New pages follow the pattern already in the repo: a `try`/`catch` around the page body with
the retry UI used by Accessories and Builds. Nothing new is needed for a database outage —
the outage notice from the health work covers every page.

## Testing

Unit tests, `environment: "node"`, no new test infrastructure:

1. **Registry invariants.** Every slug unique; every `FIREARM_TYPE` × `nfaClass = NONE`
   combination resolves to exactly one Vault section; every accessory type resolves to
   exactly one Gear section; every `GearCategory` resolves to exactly one section. Adding a
   type or class without placing it fails here rather than vanishing from the UI.
2. **Placement rule.** A firearm with a class lands in the class section regardless of
   platform — the select-fire PDW case, explicitly.
3. **NFA form rules.** `FORM_4473` clears and hides the stamp fields; `mgRegistry` is only
   accepted when the class is `MACHINE_GUN`; a non-`NONE` class does not require any
   paperwork field.
4. **Backup registry.** The existing DMMF test, extended to the two new models, plus a
   restore test for a backup that predates them.
5. **Low-stock rule.** Boundary cases for `quantity <= lowStockAlert`, including a null
   threshold meaning "never low" and a zero threshold meaning "low at zero".
6. **Legacy SMG notice.** Appears only while `SMG` rows exist; classifies nothing.

Verification beyond unit tests, per the lesson from the health work: the sections, the
conditional NFA form and the nav groups are checked in a browser at desktop and 390px
before the work is called done.

## Phases

Each phase is shippable and independently reviewable.

1. **Sections over existing data.** The registry, nav groups, section pages, `PDW` type,
   `nfaClass` and `mgRegistry` columns, `Accessory.quantity`, the legacy SMG notice. The
   registry ships with its Vault and accessory-backed Gear sections only; the `"gear"`
   source arrives with the model in phase 2, so no section can point at a table that does
   not exist yet.
2. **Gear.** The model, documents link, CRUD, Knives and Cases sections, backup, export,
   search.
3. **NFA field group.** Columns on both models, the conditional form, export columns.
4. **Supplies.** The `Supply` model, CRUD, the Cleaning / Medical / Food & Water sections,
   low-stock and expiry on the dashboard, the configurable expiry window in Settings.
5. **Preparedness gear.** The full `Gear` category set, the armor fields, the seven
   Preparedness sections and their nav group.
6. **Kits.** `Kit` and `KitItem`, the picker, target quantities and the missing count, the
   expiry rollup, over-allocation warnings, backup and export.

## Out of scope

- Deduct-on-use from maintenance logs or range sessions. Manual levels only, by decision.
- Blocking over-allocation. Flagged, never enforced.
- Nested kits — a kit inside a kit.
- Calorie or macro totals for food stores. `CAL` exists as a unit; nothing sums it.
- A dedicated cross-model NFA view. The field group lands first; the view can follow.
- Collapsing Firearm/Accessory/Ammo into one unified item model.
- Moving existing accessories into `Gear`.
- Per-magazine round counts while `quantity > 1`. A record with 12 magazines has one round
  count for the group; split it into separate records to track wear individually.
