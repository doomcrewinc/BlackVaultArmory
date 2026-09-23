# Item Categories — Design

**Date:** 2026-09-22
**Status:** Approved for planning
**Goal:** Browsable top-level sections for everything in the collection — firearms by
platform and legal class, attachable gear, standalone gear, cleaning supplies and ammo —
without restructuring the models Builds and Range depend on.

---

## Why

BlackVault tracks three kinds of thing: firearms, accessories that mount in build slots,
and ammunition. That leaves three gaps:

1. **No home for standalone kit.** A knife or a case is not a firearm, not a build slot
   accessory, and not ammo.
2. **No home for cleaning supplies**, which are consumables with levels, not serialised
   items.
3. **`Firearm.type` conflates platform with legal class.** A select-fire PDW has nowhere
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
| Cleaning supplies | New `CleaningSupply` model, manual levels with low-stock alerts |
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
  // GearCategory: KNIFE | CASE
  category        String
  quantity        Int        @default(1)
  purchasePrice   Float?
  currentValue    Float?
  acquisitionDate DateTime?
  storageLocation String?
  notes           String?
  imageUrl        String?
  imageSource     String?
  documents       Document[]
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([category])
}
```

No build slots, no round count, no battery — a knife does not mount on a rifle. `Document`
gains a nullable `gearId` and matching relation, alongside the existing `firearmId` and
`accessoryId`.

### CleaningSupply: new consumable model

```prisma
model CleaningSupply {
  id              String   @id @default(cuid())
  name            String
  brand           String?
  // CleaningCategory: SOLVENT | LUBRICANT | CLP | PATCH | BRUSH | ROD | TOOL | OTHER
  category        String
  quantity        Float    @default(0)
  // SupplyUnit: OZ | ML | COUNT | KIT
  unit            String
  lowStockAlert   Float?
  purchasePrice   Float?
  purchaseDate    DateTime?
  storageLocation String?
  notes           String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([category])
}
```

`quantity` is a `Float`, not an `Int` like `AmmoStock.quantity`: solvent is measured in
fractions of an ounce. Levels are set by hand — nothing deducts automatically, because
guessing how much CLP a cleaning used would make the numbers worse, not better.

A supply is low when `lowStockAlert` is set and `quantity <= lowStockAlert`, matching the
existing ammo low-stock rule.

### Migration shape

Every change is a new table, a new nullable column, or a new column with a default. No
existing row is rewritten and no data migration runs. Both providers get the change through
`npm run gen:schemas`; the SQLite history gains one migration and the Postgres `0_init` is
regenerated.

## The category registry

One module, `src/lib/categories.ts`, is the single source of truth for every section:

```ts
export type CategorySection = {
  slug: string;              // URL segment, unique across all sections
  label: string;             // "Machine Guns"
  group: "vault" | "gear";   // which nav group it sits under
  source: "firearm" | "accessory" | "gear";
  where: object;             // Prisma where fragment, for queries and counts
  holds: (row) => boolean;   // same rule in memory, for the invariant tests
  icon: string;
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
| Gear | Knives | gear, category `KNIFE` |
| Gear | Cases | gear, category `CASE` |

"Parts" is a grouping of existing accessory types, not a new type: muzzle devices,
handguards, stocks, buffer tubes, grips, triggers, charging handles, slides, frames,
compensators, bipods, slings, lights, lasers and underbarrel items. Every accessory type
belongs to exactly one Gear section, asserted by the same test.

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
| `/cleaning` | cleaning supplies |

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

**Cleaning page** lists supplies grouped by category with quantity, unit and a LOW badge
when under threshold. The dashboard's existing low-stock area gains cleaning supplies
beside ammo.

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
4. **Cleaning supplies.** The model, CRUD, the section, low-stock on the dashboard.

## Out of scope

- Deduct-on-use from maintenance logs. Manual levels only, by decision.
- A dedicated cross-model NFA view. The field group lands first; the view can follow.
- Collapsing Firearm/Accessory/Ammo into one unified item model.
- Moving existing accessories into `Gear`.
- Per-magazine round counts while `quantity > 1`. A record with 12 magazines has one round
  count for the group; split it into separate records to track wear individually.
