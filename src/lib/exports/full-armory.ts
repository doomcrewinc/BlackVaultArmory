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

export interface FullArmoryExportResponse {
  meta: {
    generatedAt: string;
    preset: ExportPreset;
    includesAllUploadedReceipts: boolean;
    exportOptions: FullArmoryExportOptions;
  };
  summary: {
    totalItems: number;
    totalFirearms: number;
    totalAccessories: number;
    totalGear: number;
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
