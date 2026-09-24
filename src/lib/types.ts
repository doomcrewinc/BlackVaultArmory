// ─── Firearm Types ─────────────────────────────────────────────
export const FIREARM_TYPES = [
  "PISTOL",
  "RIFLE",
  "SHOTGUN",
  "SMG",
  "PCC",
  "PDW",
  "REVOLVER",
  "BOLT_ACTION",
  "LEVER_ACTION",
] as const;

export type FirearmType = (typeof FIREARM_TYPES)[number];

export const FIREARM_TYPE_LABELS: Record<FirearmType, string> = {
  PISTOL: "Pistol",
  RIFLE: "Rifle",
  SHOTGUN: "Shotgun",
  SMG: "SMG",
  PCC: "PCC",
  PDW: "PDW",
  REVOLVER: "Revolver",
  BOLT_ACTION: "Bolt Action",
  LEVER_ACTION: "Lever Action",
};

/** The value src/app/api/firearms/route.ts writes when no type is supplied.
 *  Deliberately NOT in FIREARM_TYPES — it is not a platform a user can pick. */
export const UNSPECIFIED_FIREARM_TYPE = "UNSPECIFIED";

/**
 * A stored type token — a firearm's platform or an accessory's type — trimmed
 * and upper-cased, or "" when there is nothing to store.
 *
 * Every token in FIREARM_TYPES and SLOT_TYPES is upper-case, and the category
 * sections filter on exact matches against them. The NFA normalizers, though,
 * upper-case internally before deciding eligibility. So a body sending
 * `type: "suppressor"` was judged NFA-eligible and kept its paperwork while
 * the column stored lower-case — which missed the Suppressors filter and left
 * a registered suppressor in the Parts catch-all. Same divergence on a
 * firearm's `type` and the Title I sections.
 *
 * Upper-casing on write makes eligibility and section placement agree by
 * construction rather than by the caller's shift key.
 */
export function normalizeTypeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

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
export const MG_REGISTRIES = [
  "TRANSFERABLE",
  "PRE_SAMPLE",
  "POST_SAMPLE",
] as const;

export type MgRegistry = (typeof MG_REGISTRIES)[number];

export const MG_REGISTRY_LABELS: Record<MgRegistry, string> = {
  TRANSFERABLE: "Transferable",
  PRE_SAMPLE: "Pre-sample",
  POST_SAMPLE: "Post-sample",
};

// How an NFA item came to be owned. FORM_4473 is here because an SBR, SBS or
// suppressor can transfer on an ordinary 4473 rather than an NFA form — in
// which case there is no stamp, so there is no control number, approval date
// or tax to record.
export const NFA_TRANSFER_METHODS = [
  "FORM_1",
  "FORM_3",
  "FORM_4",
  "FORM_4473",
  "OTHER",
] as const;

export type NfaTransferMethod = (typeof NFA_TRANSFER_METHODS)[number];

export const NFA_TRANSFER_METHOD_LABELS: Record<NfaTransferMethod, string> = {
  FORM_1: "Form 1 (make)",
  FORM_3: "Form 3 (dealer to dealer)",
  FORM_4: "Form 4 (transfer)",
  FORM_4473: "4473 (no stamp)",
  OTHER: "Other",
};

// ─── Slot Types ────────────────────────────────────────────────
export const SLOT_TYPES = [
  "MUZZLE",
  "BARREL",
  "HANDGUARD",
  "STOCK",
  "BUFFER_TUBE",
  "GRIP",
  "OPTIC",
  "OPTIC_MOUNT",
  "UNDERBARREL",
  "MAGAZINE",
  "LIGHT",
  "LASER",
  "CHARGING_HANDLE",
  "TRIGGER",
  "LOWER_RECEIVER",
  "UPPER_RECEIVER",
  "SLIDE",
  "FRAME",
  "SUPPRESSOR",
  "BIPOD",
  "SLING",
  "COMPENSATOR",
] as const;

export type SlotType = (typeof SLOT_TYPES)[number];

export const SLOT_TYPE_LABELS: Record<SlotType, string> = {
  MUZZLE: "Muzzle",
  BARREL: "Barrel",
  HANDGUARD: "Handguard",
  STOCK: "Stock",
  BUFFER_TUBE: "Buffer Tube",
  GRIP: "Grip",
  OPTIC: "Optic",
  OPTIC_MOUNT: "Optic Mount",
  UNDERBARREL: "Underbarrel",
  MAGAZINE: "Magazine",
  LIGHT: "Light",
  LASER: "Laser",
  CHARGING_HANDLE: "Charging Handle",
  TRIGGER: "Trigger",
  LOWER_RECEIVER: "Lower Receiver",
  UPPER_RECEIVER: "Upper Receiver",
  SLIDE: "Slide",
  FRAME: "Frame",
  SUPPRESSOR: "Suppressor",
  BIPOD: "Bipod",
  SLING: "Sling",
  COMPENSATOR: "Compensator",
};

export const CUSTOM_SLOT_PREFIX = "CUSTOM:";

// Which slots are available per firearm type
export const SLOTS_BY_FIREARM_TYPE: Record<FirearmType, SlotType[]> = {
  RIFLE: [
    "MUZZLE",
    "BARREL",
    "HANDGUARD",
    "STOCK",
    "BUFFER_TUBE",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "UNDERBARREL",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "CHARGING_HANDLE",
    "TRIGGER",
    "LOWER_RECEIVER",
    "UPPER_RECEIVER",
    "SUPPRESSOR",
    "BIPOD",
    "SLING",
    "COMPENSATOR",
  ],
  PISTOL: [
    "MUZZLE",
    "BARREL",
    "SLIDE",
    "FRAME",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "TRIGGER",
    "SUPPRESSOR",
    "COMPENSATOR",
  ],
  SHOTGUN: [
    "MUZZLE",
    "BARREL",
    "STOCK",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "UNDERBARREL",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "TRIGGER",
    "SLING",
    "COMPENSATOR",
  ],
  SMG: [
    "MUZZLE",
    "BARREL",
    "HANDGUARD",
    "STOCK",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "UNDERBARREL",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "CHARGING_HANDLE",
    "TRIGGER",
    "SUPPRESSOR",
    "SLING",
    "COMPENSATOR",
  ],
  PCC: [
    "MUZZLE",
    "BARREL",
    "HANDGUARD",
    "STOCK",
    "BUFFER_TUBE",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "UNDERBARREL",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "CHARGING_HANDLE",
    "TRIGGER",
    "SUPPRESSOR",
    "SLING",
    "COMPENSATOR",
  ],
  PDW: [
    "MUZZLE",
    "BARREL",
    "HANDGUARD",
    "STOCK",
    "BUFFER_TUBE",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "UNDERBARREL",
    "MAGAZINE",
    "LIGHT",
    "LASER",
    "CHARGING_HANDLE",
    "TRIGGER",
    "SUPPRESSOR",
    "SLING",
    "COMPENSATOR",
  ],
  REVOLVER: [
    "BARREL",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "TRIGGER",
    "COMPENSATOR",
  ],
  BOLT_ACTION: [
    "MUZZLE",
    "BARREL",
    "STOCK",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "MAGAZINE",
    "TRIGGER",
    "BIPOD",
    "SLING",
    "SUPPRESSOR",
  ],
  LEVER_ACTION: [
    "MUZZLE",
    "BARREL",
    "STOCK",
    "GRIP",
    "OPTIC",
    "OPTIC_MOUNT",
    "TRIGGER",
    "SLING",
  ],
};

export const SUGGESTED_SLOTS_BY_FIREARM_TYPE: Record<FirearmType, SlotType[]> =
  {
    RIFLE: [
      "OPTIC",
      "BARREL",
      "MUZZLE",
      "STOCK",
      "HANDGUARD",
      "TRIGGER",
      "GRIP",
    ],
    PISTOL: ["OPTIC", "BARREL", "SLIDE", "TRIGGER", "LIGHT", "LASER"],
    BOLT_ACTION: [
      "OPTIC",
      "OPTIC_MOUNT",
      "BARREL",
      "STOCK",
      "BIPOD",
      "SUPPRESSOR",
    ],
    SHOTGUN: ["OPTIC", "BARREL", "STOCK", "LIGHT", "SLING"],
    SMG: ["OPTIC", "BARREL", "STOCK", "LIGHT", "SUPPRESSOR", "GRIP"],
    PCC: ["OPTIC", "BARREL", "MUZZLE", "STOCK", "HANDGUARD", "TRIGGER"],
    PDW: ["OPTIC", "BARREL", "MUZZLE", "STOCK", "HANDGUARD", "TRIGGER"],
    REVOLVER: ["OPTIC", "BARREL", "GRIP", "COMPENSATOR"],
    LEVER_ACTION: ["OPTIC", "BARREL", "STOCK", "SLING"],
  };

// ─── Ammo Transaction Types ────────────────────────────────────
export const TRANSACTION_TYPES = [
  "PURCHASE",
  "RANGE_USE",
  "TRANSFER_OUT",
  "INVENTORY_CORRECTION",
  "EXPENDED",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  PURCHASE: "Purchase",
  RANGE_USE: "Range Use",
  TRANSFER_OUT: "Transfer Out",
  INVENTORY_CORRECTION: "Inventory Correction",
  EXPENDED: "Expended",
};

// ─── Common Calibers ──────────────────────────────────────────
export const COMMON_CALIBERS = [
  "9mm Luger",
  ".45 ACP",
  ".40 S&W",
  ".380 ACP",
  "10mm Auto",
  ".357 Magnum",
  ".38 Special",
  ".44 Magnum",
  "5.56x45mm NATO",
  ".223 Remington",
  ".308 Winchester",
  "7.62x39mm",
  ".300 BLK",
  "6.5 Creedmoor",
  ".243 Winchester",
  ".30-06 Springfield",
  "12 Gauge",
  "20 Gauge",
  ".410 Bore",
  ".22 LR",
  ".17 HMR",
  ".22 WMR",
];

export const BULLET_TYPES = [
  "FMJ",
  "HP",
  "JHP",
  "OTM",
  "Frangible",
  "Tracer",
  "Subsonic",
  "Soft Point",
  "Match",
  "Other",
] as const;

export type BulletType = (typeof BULLET_TYPES)[number];
