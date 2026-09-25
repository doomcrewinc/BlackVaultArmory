import {
  NFA_CLASS_LABELS,
  NFA_TRANSFER_METHOD_LABELS,
  type NfaClass,
  type NfaTransferMethod,
} from "@/lib/types";

export type ExportPreset = "CLAIMS" | "BACKUP";
export type ExportFormat = "csv" | "pdf";

export interface FullArmoryExportOptions {
  preset: ExportPreset;
  includeSerialNumbers: boolean;
  includeAmmo: boolean;
  includeValue: boolean;
  includeImages: boolean;
  includeDocuments: boolean;
}

export interface FullArmoryItemRow {
  itemId: string;
  entityType: "FIREARM" | "ACCESSORY";
  /**
   * The platform for a firearm (RIFLE, PISTOL) or the type for an accessory
   * (OPTIC, SUPPRESSOR). What the item IS, physically.
   *
   * It is deliberately NOT the NFA class: an SBR is a RIFLE by platform and an
   * SBR by law, and a column that answered both questions erased one of them —
   * a select-fire PDW's platform appeared in no renderer at all. The class has
   * its own column below.
   */
  category: string;
  manufacturer: string;
  model: string;
  caliber: string;
  serialNumber: string;
  hasSerial: boolean;
  purchaseDate: string;
  purchasePrice: number | null;
  replacementValue: number | null;
  receiptCount: number;
  documentCount: number;
  hasPhoto: boolean;
  imageUrl: string;
  missingSerial: boolean;
  missingReceipt: boolean;
  missingPhoto: boolean;
  missingValue: boolean;
  notes: string;
  /**
   * NFA paperwork, carried for a firearm with a class and for a suppressor.
   * Blank string / null on an item that has none.
   *
   * nfaControlNumber is gated behind includeSerialNumbers, because it
   * identifies a registered item as precisely as a serial number does. It is
   * blanked and keeps its key, the same way serialNumber is — the gate's
   * rationale is "as precisely as a serial", so the mechanism matches it, the
   * CSV header stays the same shape between exports, and no consumer has an
   * optional property to narrow.
   *
   * nfaTaxPaid is gated behind includeValue, like purchasePrice and
   * replacementValue: it is a dollar amount, and it is nulled rather than
   * dropped so the column keeps its shape.
   */
  nfaTransferMethod: string;
  nfaControlNumber: string;
  nfaApprovalDate: string;
  nfaTaxPaid: number | null;
  nfaRegisteredTo: string;
  /**
   * How the item is regulated, independent of `category`. The stored token
   * (SBR, MACHINE_GUN, NONE) for a firearm; blank for an accessory, which has
   * no class column on its model at all — blank means "not applicable" here,
   * while a firearm says NONE for Title I.
   */
  nfaClass: string;
}

export interface FullArmoryAttachmentRow {
  documentId: string;
  type: string;
  name: string;
  linkedItemId: string;
  linkedItemType: "FIREARM" | "ACCESSORY" | "GEAR" | "UNATTACHED";
  linkedItemName: string;
  mimeType: string;
  fileSize: number | string;
  fileUrl: string;
  uploadedAt: string;
}

export interface FullArmoryAmmoRow {
  ammoId: string;
  brand: string;
  caliber: string;
  quantity: number;
  lowStockAlert: number | null;
  purchasePrice: number | null;
  notes: string;
}

export interface FullArmoryGearRow {
  gearId: string;
  name: string;
  category: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  quantity: number;
  purchasePrice: number | null;
  currentValue: number | null;
  acquisitionDate: string;
  /**
   * Armor plates and filters have a rated life; a knife does not. Blank on a
   * row with no date, exactly as acquisitionDate is.
   */
  expirationDate: string;
  /**
   * "none" | "fine" | "soon" | "expired", resolved server-side against the one
   * `today` the route resolves per request — the same value the supply rows
   * used, and the one the meta footnote names a timezone for.
   */
  expiryStatus: string;
  /**
   * The armor rating and the plate cut, EACH IN ITS OWN FIELD and neither
   * folded into `category`. Phase 3 folded a firearm's platform into its NFA
   * class and printed "Class: PISTOL" for an SBR; a plate's category is
   * "Armor" and its rating is "NIJ III+", and a claims sheet needs both.
   *
   * Empty string on a row that has no rating — which is every non-armor row,
   * because the write path clears both fields the moment a category stops
   * being ARMOR. Deliberately NOT gated on the category here: a category this
   * build does not recognise keeps whatever it stored (see
   * normalizeGearArmorFields), and an export must not be the one place that
   * drops it. Empty, never "—" and never the string "null": a dash is a
   * renderer's choice and belongs in the renderer.
   */
  protectionLevel: string;
  armorSize: string;
  storageLocation: string;
  receiptCount: number;
  documentCount: number;
  hasPhoto: boolean;
  imageUrl: string;
  missingSerial: boolean;
  missingReceipt: boolean;
  missingPhoto: boolean;
  missingValue: boolean;
  notes: string;
}

export interface FullArmorySupplyRow {
  supplyId: string;
  name: string;
  brand: string;
  /** The human label (e.g. "Medical"), matching how gear's category is exported. */
  category: string;
  /** A decimal, never floored — solvent comes in fractions of an ounce. */
  quantity: number;
  /** The human unit label (e.g. "oz"), matching how gear's category is exported. */
  unit: string;
  lowStockAlert: number | null;
  expirationDate: string;
  /**
   * "none" | "fine" | "soon" | "expired", resolved server-side against a
   * single `today` the caller reads once — see expiryStatus/todayForExpiry
   * in lib/supply.ts. Never recomputed per row against the live clock.
   */
  expiryStatus: string;
  purchasePrice: number | null;
  purchaseDate: string;
  storageLocation: string;
  /**
   * A supply has no serial, no photo and no Document relation, so only the
   * value counter meaningfully applies to it — unlike gear, which carries
   * all four missing* signals. missingSerial/missingPhoto/missingReceipt are
   * deliberately absent from this row rather than hardcoded false: those
   * concepts do not exist for a supply at all.
   */
  missingValue: boolean;
  notes: string;
}

/**
 * One kit, as its own row of the export's Kits section.
 *
 * SIX SEPARATE VALUES, none folded into another. Phase 3 shipped an export
 * that folded a firearm's platform into its NFA class and printed
 * "Class: PISTOL" for an SBR; "Bugout Bag — 12 items (2 missing), expires
 * 2026-11-01" is the same mistake in a nicer font. A claims reader sorting by
 * location, or counting what is short, needs each of these to be its own
 * column.
 *
 * A kit is a CONTAINER, not an item: its lines point at Firearm, Accessory,
 * Gear, Supply and AmmoStock rows that the export already lists in full
 * elsewhere. So this row carries no price and no serial — nothing here is a
 * second copy of an inventory row — and kits are deliberately absent from
 * `totalItems` and from both value totals, which would otherwise double-count
 * every packed item. `totalKits` reports them separately.
 */
export interface FullArmoryKitRow {
  kitId: string;
  name: string;
  /** The human label ("Bugout"), matching how gear and supply categories are exported. */
  category: string;
  /** Where the kit itself lives. Blank, never "—": a dash is a renderer's choice. */
  location: string;
  /** How many KitItem lines the kit holds, packed or not. */
  itemCount: number;
  /**
   * Summed `missingQuantity` across the kit's lines — how many more of
   * everything are needed to reach the targets that are set. 0 when nothing
   * has a target, which is not the same as "the kit is complete" and is why
   * `itemCount` sits beside it.
   */
  missingCount: number;
  /**
   * YYYY-MM-DD of the earliest-expiring thing in the kit, or "" when nothing
   * in it carries a date. Only Gear and Supply lines can: Accessory,
   * AmmoStock, Firearm and label-only lines have no expiry to roll up.
   */
  earliestExpiry: string;
  /**
   * "none" | "fine" | "soon" | "expired" for `earliestExpiry`, resolved
   * server-side against the SAME `today` the gear and supply rows used — the
   * one the meta footnote names a timezone and a day for.
   */
  expiryStatus: string;
  /** How many of the kit's lines are already expired, and how many are inside the window. */
  expiredLineCount: number;
  expiringSoonLineCount: number;
  notes: string;
}

export interface FullArmoryExportResponse {
  meta: {
    generatedAt: string;
    preset: ExportPreset;
    includesAllUploadedReceipts: boolean;
    exportOptions: FullArmoryExportOptions;
    /**
     * Which timezone decided every `expiryStatus` in this payload, and which
     * calendar day it decided them on — taken from the ONE resolved expiry
     * context the gear and supply rows were mapped with, never a second
     * `new Date()` and never a second AppSettings read. Carried on the payload
     * rather than recomputed by each renderer so the CSV, the PDF and the
     * preview cannot disclose a different day than the rows they annotate.
     *
     * `expiryTimezoneFromSetting` is false when AppSettings.timezone is unset
     * (or unusable) and the host's zone stood in — see resolveExpiryTimeZone.
     */
    expiryTimezone: string;
    expiryTimezoneFromSetting: boolean;
    /** YYYY-MM-DD, the resolved "today" in `expiryTimezone`. */
    expiryEvaluatedOn: string;
  };
  summary: {
    totalItems: number;
    totalFirearms: number;
    totalAccessories: number;
    totalGear: number;
    totalSupplies: number;
    /**
     * Counted and reported SEPARATELY from totalItems. A kit is a container
     * whose lines point at rows already counted as gear, supplies, firearms,
     * accessories and ammo; adding it to totalItems would inflate the headline
     * by the number of bags the user owns.
     */
    totalKits: number;
    totalDocuments: number;
    totalReceipts: number;
    totalAmmoStocks: number;
    totalPurchaseValue: number;
    totalReplacementValue: number;
    missingEvidence: {
      missingReceipts: number;
      missingPhotos: number;
      missingValues: number;
      missingSerials: number;
    };
  };
  items: FullArmoryItemRow[];
  attachments: FullArmoryAttachmentRow[];
  ammo: FullArmoryAmmoRow[];
  gear: FullArmoryGearRow[];
  supplies: FullArmorySupplyRow[];
  kits: FullArmoryKitRow[];
}

export interface VisualEvidenceImage {
  id: string;
  source: "ITEM_PHOTO" | "RECEIPT_IMAGE";
  title: string;
  imageUrl: string;
  linkedItemId: string;
  linkedItemName: string;
  uploadedAt?: string;
}

/**
 * The one sentence that says which timezone decided "expired" in this export,
 * and on which day.
 *
 * The export is the fourth expiryStatus call site and was the only one that
 * disclosed nothing: a sheet handed to an adjuster said a plate was expired
 * without saying whose calendar it was read against, which is a day-wide
 * difference on either side of local midnight.
 *
 * It covers the KIT rows as well as the gear and supply ones, and does so
 * without a word changing: every verdict on the sheet — a plate's, a water
 * pouch's, and a kit's rolled-up earliest expiry — comes from the one resolved
 * context this sentence reports, so one sentence is the honest count. The kit
 * rollup calls the same `expiryStatus` against the same `today`; it does not
 * read a clock of its own.
 *
 * Both values come off `payload.meta`, which the route fills from the single
 * resolved expiry context its rows were mapped with. Every renderer — CSV,
 * PDF, the print preview — calls this, so the wording cannot drift between
 * them and none of them can reach for its own clock.
 *
 * "(server default)" is appended when AppSettings.timezone is unset, naming
 * the host zone that stood in rather than pretending it was chosen.
 */
export function formatExpiryFootnote(meta: {
  expiryTimezone: string;
  expiryTimezoneFromSetting: boolean;
  expiryEvaluatedOn: string;
}): string {
  const zone = meta.expiryTimezoneFromSetting
    ? meta.expiryTimezone
    : `${meta.expiryTimezone} (server default)`;
  return `Expiry evaluated in ${zone} on ${meta.expiryEvaluatedOn}.`;
}

/**
 * Whether an item row has any paperwork worth printing. Deliberately not keyed
 * on nfaControlNumber alone: that field is withheld when serials are excluded,
 * and the rest of the paperwork still has to print.
 *
 * Shared by the PDF renderer and the preview's NFA Paperwork section so the
 * two agree on which items are "registered".
 */
export function hasNfaPaperwork(
  item: Pick<
    FullArmoryItemRow,
    | "nfaTransferMethod"
    | "nfaControlNumber"
    | "nfaApprovalDate"
    | "nfaTaxPaid"
    | "nfaRegisteredTo"
  >
): boolean {
  return Boolean(
    item.nfaTransferMethod ||
      item.nfaControlNumber ||
      item.nfaApprovalDate ||
      item.nfaTaxPaid != null ||
      item.nfaRegisteredTo
  );
}

/**
 * The human labels for the two NFA enum columns, for the two human-facing
 * renderers (the PDF an adjuster reads and the print preview). JSON and CSV
 * keep the raw tokens their machine consumers parse.
 *
 * Both take the exported string rather than a narrowed union, because an
 * export row carries whatever the column holds; anything unrecognised falls
 * back to the raw token rather than being hidden.
 */
export function nfaClassLabel(token: string): string {
  const key = token.trim().toUpperCase();
  // NONE and blank both render as "no class to report": a Title I firearm and
  // an accessory (which has no class column) are equally not NFA-classified,
  // and the caller decides what a blank looks like ("—", or an omitted line).
  if (!key || key === "NONE") return "";
  return NFA_CLASS_LABELS[key as NfaClass] ?? token;
}

export function nfaTransferMethodLabel(token: string): string {
  const key = token.trim().toUpperCase();
  if (!key) return "";
  return NFA_TRANSFER_METHOD_LABELS[key as NfaTransferMethod] ?? token;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif"];

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export function parseExportOptionsFromSearchParams(searchParams: URLSearchParams): FullArmoryExportOptions {
  const presetRaw = searchParams.get("preset");

  return {
    preset: presetRaw === "BACKUP" ? "BACKUP" : "CLAIMS",
    includeSerialNumbers: parseBool(searchParams.get("includeSerialNumbers"), true),
    includeAmmo: parseBool(searchParams.get("includeAmmo"), true),
    includeValue: parseBool(searchParams.get("includeValue"), true),
    includeImages: parseBool(searchParams.get("includeImages"), true),
    includeDocuments: parseBool(searchParams.get("includeDocuments"), true),
  };
}

export function parseExportFormatFromSearchParams(searchParams: URLSearchParams): ExportFormat | null {
  const raw = (searchParams.get("format") ?? "").toLowerCase();
  if (raw === "") return null;
  return raw === "csv" || raw === "pdf" ? raw : null;
}

export function buildExportQueryString(options: FullArmoryExportOptions, format?: ExportFormat): string {
  const query = new URLSearchParams();
  if (format) query.set("format", format);
  query.set("preset", options.preset);
  query.set("includeSerialNumbers", String(options.includeSerialNumbers));
  query.set("includeAmmo", String(options.includeAmmo));
  query.set("includeValue", String(options.includeValue));
  query.set("includeImages", String(options.includeImages));
  query.set("includeDocuments", String(options.includeDocuments));
  return query.toString();
}

function isImageAttachment(row: FullArmoryAttachmentRow): boolean {
  const mime = (row.mimeType ?? "").toLowerCase();
  if (mime.startsWith("image/")) return true;

  const url = (row.fileUrl ?? "").toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => url.endsWith(ext));
}

export function selectVisualEvidence(
  payload: Pick<FullArmoryExportResponse, "items" | "attachments"> &
    Partial<Pick<FullArmoryExportResponse, "gear">>,
  options: FullArmoryExportOptions
): VisualEvidenceImage[] {
  const images: VisualEvidenceImage[] = [];

  if (options.includeImages) {
    for (const item of payload.items) {
      if (!item.imageUrl) continue;
      images.push({
        id: `item:${item.itemId}`,
        source: "ITEM_PHOTO",
        title: `${item.entityType}: ${item.manufacturer} ${item.model}`.trim(),
        imageUrl: item.imageUrl,
        linkedItemId: item.itemId,
        linkedItemName: item.model || item.manufacturer || item.itemId,
      });
    }

    // Gear counts toward totalItems and the value totals, so its photos are
    // part of the same evidence set. Keyed `item:` like the rows above: gear
    // ids and firearm/accessory ids are all cuids from separate tables, so a
    // separate prefix would only make the two look like different kinds of
    // evidence in the renderers.
    for (const item of payload.gear ?? []) {
      if (!item.imageUrl) continue;
      images.push({
        id: `item:${item.gearId}`,
        source: "ITEM_PHOTO",
        title: `GEAR: ${item.manufacturer} ${item.name}`.trim(),
        imageUrl: item.imageUrl,
        linkedItemId: item.gearId,
        linkedItemName: item.name || item.manufacturer || item.gearId,
      });
    }
  }

  if (options.includeDocuments) {
    for (const row of payload.attachments) {
      if (!row.fileUrl || !isImageAttachment(row)) continue;

      images.push({
        id: `doc:${row.documentId}`,
        source: "RECEIPT_IMAGE",
        title: `${row.type}: ${row.name}`,
        imageUrl: row.fileUrl,
        linkedItemId: row.linkedItemId || "UNATTACHED",
        linkedItemName: row.linkedItemName || "Unattached",
        uploadedAt: row.uploadedAt,
      });
    }
  }

  return images;
}
