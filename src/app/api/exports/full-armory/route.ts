import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptField } from "@/lib/crypto";
import { toISODate } from "@/lib/date";
import {
  parseExportFormatFromSearchParams,
  type ExportFormat,
  type ExportPreset,
  parseExportOptionsFromSearchParams,
  hasNfaPaperwork,
  formatExpiryFootnote,
  nfaClassLabel,
  nfaTransferMethodLabel,
  type FullArmoryAttachmentRow,
  type FullArmoryExportResponse,
} from "@/lib/exports/full-armory";
import { requireAuth } from "@/lib/server/auth";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";
import { KIT_CATEGORY_LABELS, type KitCategory } from "@/lib/kit";
import { kitExpiryRollup, missingQuantity, type KitExpiryLine } from "@/lib/kits/allocation";
import {
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_UNIT_LABELS,
  expiryStatus,
  resolveExpiryContext,
  type SupplyCategory,
  type SupplyUnit,
} from "@/lib/supply";

function gearCategoryLabel(category: string): string {
  return GEAR_CATEGORY_LABELS[category as GearCategory] ?? category;
}

function supplyCategoryLabel(category: string): string {
  return SUPPLY_CATEGORY_LABELS[category as SupplyCategory] ?? category;
}

function supplyUnitLabel(unit: string): string {
  return SUPPLY_UNIT_LABELS[unit as SupplyUnit] ?? unit;
}

/**
 * Falls back to the stored token for a category this build does not know —
 * the same rule gearCategoryLabel and supplyCategoryLabel follow, and for the
 * same reason: restore inserts kit rows unvalidated, and a category from a
 * later build must print as itself rather than vanish.
 */
function kitCategoryLabel(category: string): string {
  return KIT_CATEGORY_LABELS[category as KitCategory] ?? category;
}

/** The paperwork group as it comes off a firearm or an accessory row. */
type NfaPaperworkRecord = {
  nfaTransferMethod: string | null;
  nfaControlNumber: string | null;
  nfaApprovalDate: Date | null;
  nfaTaxPaid: number | null;
  nfaRegisteredTo: string | null;
};

type FirearmExportRecord = NfaPaperworkRecord & {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  caliber: string | null;
  serialNumber: string | null;
  type: string | null;
  nfaClass: string | null;
  acquisitionDate: Date | null;
  purchasePrice: number | null;
  currentValue: number | null;
  notes: string | null;
  imageUrl: string | null;
};

type AccessoryExportRecord = NfaPaperworkRecord & {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  type: string | null;
  caliber: string | null;
  acquisitionDate: Date | null;
  purchasePrice: number | null;
  notes: string | null;
  imageUrl: string | null;
};

/**
 * How the firearm is regulated, as its own column beside the platform.
 *
 * An SBR is a RIFLE by platform and an SBR by law, and a claims reader needs
 * both: the platform describes the item, the class describes the paperwork it
 * must have. One column reporting "the class, falling back to the platform"
 * answered neither question reliably — a machine gun's PDW-ness appeared in no
 * renderer at all, and every Title I row and every accessory read as if its
 * platform were an NFA class.
 *
 * Emitted as the stored token (SBR, MACHINE_GUN, NONE), matching the raw
 * platform tokens the category column has always carried. The two human
 * renderers turn it into a label; JSON and CSV keep the token.
 */
function firearmExportNfaClass(firearm: Pick<FirearmExportRecord, "nfaClass">): string {
  return (firearm.nfaClass ?? "").trim().toUpperCase();
}

/**
 * The five paperwork columns, shared by firearm and accessory rows.
 *
 * Two of them are withheld by the export's own options:
 *
 * nfaControlNumber unless serials are included — it identifies a registered
 * item as precisely as a serial number does, and a user who excluded serials
 * asked not to publish identifiers. It is blanked and keeps its key, which is
 * exactly what the export does to serialNumber: the rationale for gating it
 * was "as precisely as a serial", so the mechanism matches the rationale. That
 * also keeps the CSV header stable between two exports of the same armory and
 * spares every consumer an optional property to narrow.
 *
 * nfaTaxPaid unless values are included — it is a dollar amount, and an export
 * that hides every purchase price and replacement value while printing a $200
 * tax stamp is not honouring the toggle the user set. It is nulled rather than
 * dropped, exactly like purchasePrice and replacementValue, which are the
 * columns it belongs with.
 *
 * The remaining three are neither identifiers nor amounts and ride
 * unconditionally.
 */
function nfaPaperworkColumns(
  record: NfaPaperworkRecord,
  includeControlNumber: boolean,
  includeValue: boolean
) {
  return {
    nfaTransferMethod: record.nfaTransferMethod ?? "",
    nfaControlNumber: includeControlNumber ? (record.nfaControlNumber ?? "") : "",
    nfaApprovalDate: toISODate(record.nfaApprovalDate),
    nfaTaxPaid: includeValue ? (record.nfaTaxPaid ?? null) : null,
    nfaRegisteredTo: record.nfaRegisteredTo ?? "",
  };
}

type ExportDocumentRecord = {
  id: string;
  type: string;
  name: string;
  firearmId: string | null;
  accessoryId: string | null;
  gearId: string | null;
  firearm: { id: string; name: string } | null;
  accessory: { id: string; name: string } | null;
  gear: { id: string; name: string } | null;
  mimeType: string | null;
  fileSize: number | null;
  fileUrl: string;
  createdAt: Date;
};

type ExportAmmoRecord = {
  id: string;
  brand: string | null;
  caliber: string | null;
  quantity: number;
  lowStockAlert: number | null;
  purchasePrice: number | null;
  notes: string | null;
};

type GearExportRecord = {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  category: string;
  quantity: number;
  purchasePrice: number | null;
  currentValue: number | null;
  acquisitionDate: Date | null;
  expirationDate: Date | null;
  protectionLevel: string | null;
  armorSize: string | null;
  storageLocation: string | null;
  notes: string | null;
  imageUrl: string | null;
};

type SupplyExportRecord = {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  quantity: number;
  unit: string;
  lowStockAlert: number | null;
  expirationDate: Date | null;
  purchasePrice: number | null;
  purchaseDate: Date | null;
  storageLocation: string | null;
  notes: string | null;
};

/**
 * One kit as this export reads it: its own scalars plus only what the rollups
 * need off each line.
 *
 * The `select` is narrow on purpose and asks for NO serial number anywhere —
 * not on the kit, and not on any of the five rows a line can point at. Three
 * of those five tables carry a serial, and an `include: { firearm: true }`
 * here would have put one in a claims sheet on a path neither the
 * includeSerialNumbers gate nor any strip in this route visits. The kit
 * section reports counts and dates; it never restates an inventory row, which
 * the Master Inventory and Gear sections already carry in full.
 *
 * Only Gear and Supply are asked for an expirationDate, because they are the
 * only two sources that have one — an Accessory, an AmmoStock, a Firearm and a
 * label-only line have no expiry to roll up.
 */
type KitExportRecord = {
  id: string;
  name: string;
  category: string;
  location: string | null;
  notes: string | null;
  items: Array<{
    quantity: number;
    targetQuantity: number | null;
    gear: { expirationDate: Date | null } | null;
    supply: { expirationDate: Date | null } | null;
  }>;
};

type PrismaWithOptionalDocument = typeof prisma & {
  document?: {
    findMany: (args: {
      orderBy: { createdAt: "asc" }[];
      include: {
        firearm: { select: { id: true; name: true } };
        accessory: { select: { id: true; name: true } };
        gear: { select: { id: true; name: true } };
      };
    }) => Promise<ExportDocumentRecord[]>;
  };
};

async function findDocumentsForExport(): Promise<ExportDocumentRecord[]> {
  const prismaMaybeDocument = prisma as PrismaWithOptionalDocument;
  if (!prismaMaybeDocument.document?.findMany) return [];
  return prismaMaybeDocument.document.findMany({
    orderBy: [{ createdAt: "asc" }],
    include: {
      firearm: { select: { id: true, name: true } },
      accessory: { select: { id: true, name: true } },
      gear: { select: { id: true, name: true } },
    },
  });
}

function toCsvCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(value: unknown): string {
  const text = toCsvCellValue(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function flattenRecord(input: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      Object.assign(output, flattenRecord(value as Record<string, unknown>, nextPath));
      continue;
    }
    output[nextPath] = value;
  }
  return output;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>())
  );

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvEscape(row[header])).join(","));
  }
  return lines.join("\n");
}

function buildExportCsv(payload: FullArmoryExportResponse): string {
  const metaRows = [
    { section: "summary", key: "generatedAt", value: payload.meta.generatedAt },
    // Beside generatedAt, the only other line that says when and where this
    // sheet's verdicts came from. Every gear and supply row carries an
    // expiryStatus column; without this the reader cannot tell whose calendar
    // day decided them.
    { section: "summary", key: "expiryFootnote", value: formatExpiryFootnote(payload.meta) },
    { section: "summary", key: "preset", value: payload.meta.preset },
    { section: "summary", key: "totalItems", value: payload.summary.totalItems },
    { section: "summary", key: "totalFirearms", value: payload.summary.totalFirearms },
    { section: "summary", key: "totalAccessories", value: payload.summary.totalAccessories },
    { section: "summary", key: "totalGear", value: payload.summary.totalGear },
    { section: "summary", key: "totalSupplies", value: payload.summary.totalSupplies },
    { section: "summary", key: "totalKits", value: payload.summary.totalKits },
    { section: "summary", key: "totalAmmoStocks", value: payload.summary.totalAmmoStocks },
    { section: "summary", key: "totalDocuments", value: payload.summary.totalDocuments },
    { section: "summary", key: "totalReceipts", value: payload.summary.totalReceipts },
    { section: "summary", key: "totalPurchaseValue", value: payload.summary.totalPurchaseValue },
    { section: "summary", key: "totalReplacementValue", value: payload.summary.totalReplacementValue },
  ];

  const itemRows = payload.items.map((item) => ({
    section: "inventory",
    ...flattenRecord(item as unknown as Record<string, unknown>),
  }));
  const ammoRows = payload.ammo.map((row) => ({
    section: "ammo",
    ...flattenRecord(row as unknown as Record<string, unknown>),
  }));
  const attachmentRows = payload.attachments.map((row) => ({
    section: "attachments",
    ...flattenRecord(row as unknown as Record<string, unknown>),
  }));
  const gearRows = payload.gear.map((row) => ({
    section: "gear",
    ...flattenRecord(row as unknown as Record<string, unknown>),
  }));
  const supplyRows = payload.supplies.map((row) => ({
    section: "supplies",
    ...flattenRecord(row as unknown as Record<string, unknown>),
  }));
  const kitRows = payload.kits.map((row) => ({
    section: "kits",
    ...flattenRecord(row as unknown as Record<string, unknown>),
  }));

  return rowsToCsv([
    ...metaRows,
    ...itemRows,
    ...ammoRows,
    ...attachmentRows,
    ...gearRows,
    ...supplyRows,
    ...kitRows,
  ]);
}

function pdfEscape(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function buildSimplePdf(lines: string[]): string {
  const pageLines = 46;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += pageLines) pages.push(lines.slice(i, i + pageLines));
  if (pages.length === 0) pages.push([""]);

  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
  const pageObjectNumbers: number[] = [];
  const contentObjectNumbers: number[] = [];

  for (let i = 0; i < pages.length; i += 1) {
    const pageObjNum = objects.length + 1;
    const contentObjNum = pageObjNum + 1;
    pageObjectNumbers.push(pageObjNum);
    contentObjectNumbers.push(contentObjNum);
    objects.push("");
    objects.push("");
  }

  const fontObjNum = objects.length + 1;
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  for (let i = 0; i < pages.length; i += 1) {
    const streamLines = ["BT", "/F1 10 Tf", "14 TL", "50 742 Td"];
    pages[i].forEach((line, lineIndex) => {
      if (lineIndex > 0) streamLines.push("T*");
      streamLines.push(`(${pdfEscape(line)}) Tj`);
    });
    streamLines.push("ET");

    const stream = streamLines.join("\n");
    const length = Buffer.byteLength(stream, "utf8");
    const pageObjNum = pageObjectNumbers[i];
    const contentObjNum = contentObjectNumbers[i];

    objects[pageObjNum - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`;
    objects[contentObjNum - 1] = `<< /Length ${length} >>\nstream\n${stream}\nendstream`;
  }

  let pdf = "%PDF-1.4\n%BLACKVAULT\n";
  const offsets: number[] = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets[i + 1] = Buffer.byteLength(pdf, "utf8");
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

function wrapText(line: string, maxChars = 98): string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(/\s+/).filter(Boolean);
  const wrapped: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    const next = `${current} ${word}`;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }
    wrapped.push(current);
    current = word;
  }

  if (current) wrapped.push(current);
  return wrapped.length ? wrapped : [line];
}

function pushWrapped(lines: string[], line: string, indent = ""): void {
  const wrapped = wrapText(line);
  wrapped.forEach((part, index) => lines.push(index === 0 ? `${indent}${part}` : `${indent}  ${part}`));
}

/**
 * The `Expires: <date> (<status>)` segment for a PDF row, or null when the row
 * has no date to report.
 *
 * Shared by the gear and the supply renderers because they had drifted into two
 * OPPOSITE conventions inside one rendered document: gear omitted the segment
 * while supplies printed `Expiry: N/A (none)` on every dateless row, so a
 * reader comparing a plate to a water jug on the same sheet had to know which
 * block followed which rule. One function and one label, so they cannot
 * diverge again.
 *
 * The convention is the gear one, which is also the rule the NFA line follows:
 * print nothing where there is nothing to say. `(status)` is likewise dropped
 * when the status is "none", which is the only status a dateless row can have
 * — so it never appears in practice, and the guard is there because
 * expiryStatus also returns "none" for a date it could not parse.
 *
 * `label` exists for the kit rows and for nothing else. A kit does not expire;
 * the earliest-expiring thing INSIDE it does, so that row reads "Earliest
 * Expiry" while a plate and a water pouch read "Expires". Sharing the function
 * and varying the label keeps one implementation of the print-nothing-where-
 * there-is-nothing convention without printing a date under a heading that
 * claims something the value does not say.
 */
function expirySegment(
  expirationDate: string,
  expiryStatus: string,
  label = "Expires"
): string | null {
  if (!expirationDate) return null;
  return `${label}: ${expirationDate}${expiryStatus !== "none" ? ` (${expiryStatus})` : ""}`;
}

function buildExportPdfLines(payload: FullArmoryExportResponse): string[] {
  const lines: string[] = [
    "Project BlackVault - Full Armory Export",
    `Generated: ${payload.meta.generatedAt}`,
    formatExpiryFootnote(payload.meta),
    `Preset: ${payload.meta.preset}`,
    `Items: ${payload.summary.totalItems} | Ammo Lots: ${payload.summary.totalAmmoStocks} | Documents: ${payload.summary.totalDocuments}`,
    `Purchase Total: ${payload.summary.totalPurchaseValue.toFixed(2)} | Replacement Total: ${payload.summary.totalReplacementValue.toFixed(2)}`,
    "",
    "Inventory",
  ];

  if (payload.items.length === 0) {
    lines.push("No inventory records included");
  }

  payload.items.forEach((item, index) => {
    // Type is the platform / accessory type; Class is the NFA class and is
    // printed only where there is one, because "Class: N/A" on every Title I
    // row and every accessory is what made the old single column read wrong
    // (`Class: PISTOL`, `Class: OPTIC`). Labels rather than tokens here and in
    // the NFA line below: this is the renderer an adjuster reads, and the app's
    // own detail pages already show "Form 4 (transfer)".
    const classLabel = nfaClassLabel(item.nfaClass);
    pushWrapped(
      lines,
      `${index + 1}. ${item.entityType} ${item.manufacturer} ${item.model} | Type: ${item.category || "N/A"}${classLabel ? ` | Class: ${classLabel}` : ""} | Serial: ${item.serialNumber || "N/A"} | Purchase: ${item.purchasePrice ?? "N/A"} | Value: ${item.replacementValue ?? "N/A"}`
    );
    // Only for a record that has paperwork: an "NFA: N/A | Control: N/A | ..."
    // line under every Title I item would double the page count to say nothing.
    // Control reads N/A when serials are excluded, matching the Serial field
    // above rather than inventing a third convention for a withheld value.
    if (hasNfaPaperwork(item)) {
      pushWrapped(
        lines,
        `NFA: ${nfaTransferMethodLabel(item.nfaTransferMethod) || "N/A"} | Control: ${item.nfaControlNumber || "N/A"} | Approved: ${item.nfaApprovalDate || "N/A"} | Tax: ${item.nfaTaxPaid ?? "N/A"} | Registered To: ${item.nfaRegisteredTo || "N/A"}`,
        "   "
      );
    }
    if (item.imageUrl) pushWrapped(lines, `Image Ref: ${item.imageUrl}`, "   ");
  });

  lines.push("", "Ammo");
  if (payload.ammo.length === 0) {
    lines.push("No ammo records included");
  } else {
    payload.ammo.forEach((row, index) => {
      pushWrapped(lines, `${index + 1}. ${row.brand} ${row.caliber} | Qty: ${row.quantity} | Price: ${row.purchasePrice ?? "N/A"}`);
    });
  }

  lines.push("", "Documents");
  if (payload.attachments.length === 0) {
    lines.push("No documents included");
  } else {
    payload.attachments.forEach((row, index) => {
      pushWrapped(lines, `${index + 1}. ${row.type} ${row.name} | Linked: ${row.linkedItemName || row.linkedItemType}`);
      if (row.fileUrl) pushWrapped(lines, `File Ref: ${row.fileUrl}`, "   ");
    });
  }

  lines.push("", "Gear");
  if (payload.gear.length === 0) {
    lines.push("No gear records included");
  } else {
    payload.gear.forEach((row, index) => {
      // Each value gets its own labelled segment — the rating is never folded
      // into the category, which is the phase-3 "Class: PISTOL" mistake.
      // Printed only where there is something to print, the same rule the NFA
      // line below follows: "Protection: N/A" on every knife and case would
      // double the page count to say nothing, and a plate's rating would be
      // harder to find for it.
      const extras: string[] = [];
      const expiry = expirySegment(row.expirationDate, row.expiryStatus);
      if (expiry) extras.push(expiry);
      if (row.protectionLevel) extras.push(`Protection: ${row.protectionLevel}`);
      if (row.armorSize) extras.push(`Size/Cut: ${row.armorSize}`);
      pushWrapped(
        lines,
        `${index + 1}. ${row.category} ${row.name} | Serial: ${row.serialNumber || "N/A"} | Qty: ${row.quantity} | Purchase: ${row.purchasePrice ?? "N/A"} | Value: ${row.currentValue ?? "N/A"}${extras.length > 0 ? ` | ${extras.join(" | ")}` : ""}`
      );
      if (row.imageUrl) pushWrapped(lines, `Image Ref: ${row.imageUrl}`, "   ");
    });
  }

  lines.push("", "Supplies");
  if (payload.supplies.length === 0) {
    lines.push("No supply records included");
  } else {
    payload.supplies.forEach((row, index) => {
      // Same segment helper the gear rows above use: a dateless supply now says
      // nothing rather than "Expiry: N/A (none)", so both blocks of this one
      // document follow one convention.
      const expiry = expirySegment(row.expirationDate, row.expiryStatus);
      pushWrapped(
        lines,
        `${index + 1}. ${row.category} ${row.name} | Brand: ${row.brand || "N/A"} | Qty: ${row.quantity} ${row.unit} | Threshold: ${row.lowStockAlert ?? "N/A"}${expiry ? ` | ${expiry}` : ""} | Price: ${row.purchasePrice ?? "N/A"} | Storage: ${row.storageLocation || "N/A"}`
      );
    });
  }

  lines.push("", "Kits");
  if (payload.kits.length === 0) {
    lines.push("No kit records included");
  } else {
    payload.kits.forEach((row, index) => {
      // SIX labelled segments, one per value, never collapsed into a sentence
      // — the phase-3 "Class: PISTOL" mistake was two fields sharing a column,
      // and "Bugout Bag: 12 items, 2 missing, 2026-11-01" is the same mistake.
      // `Expires` uses the shared expirySegment helper, so a kit with nothing
      // dated in it prints nothing rather than "Expires: N/A (none)" — the one
      // convention the gear and supply blocks above already follow.
      const expiry = expirySegment(row.earliestExpiry, row.expiryStatus, "Earliest Expiry");
      pushWrapped(
        lines,
        `${index + 1}. ${row.category} ${row.name} | Location: ${row.location || "N/A"} | Items: ${row.itemCount} | Missing: ${row.missingCount}${expiry ? ` | ${expiry}` : ""}`
      );
    });
  }

  return lines;
}

function buildFileName(extension: ExportFormat): string {
  const date = new Date().toISOString().slice(0, 10);
  return `blackvault-export-${date}.${extension}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const format = parseExportFormatFromSearchParams(request.nextUrl.searchParams);
    if (request.nextUrl.searchParams.has("format") && !format) {
      return NextResponse.json({ error: "Invalid format. Supported values: csv, pdf" }, { status: 400 });
    }

    const exportOptions = parseExportOptionsFromSearchParams(request.nextUrl.searchParams);
    const preset: ExportPreset = exportOptions.preset;

    // Sequential queries — SQLite connection_limit=1 cannot handle concurrent reads
    const firearms = (await prisma.firearm.findMany({
      select: {
        id: true,
        name: true,
        manufacturer: true,
        model: true,
        caliber: true,
        serialNumber: true,
        type: true,
        nfaClass: true,
        nfaTransferMethod: true,
        nfaControlNumber: true,
        nfaApprovalDate: true,
        nfaTaxPaid: true,
        nfaRegisteredTo: true,
        acquisitionDate: true,
        purchasePrice: true,
        currentValue: true,
        notes: true,
        imageUrl: true,
      },
      orderBy: [{ manufacturer: "asc" }, { model: "asc" }, { name: "asc" }],
    })) as FirearmExportRecord[];
    const accessories = (await prisma.accessory.findMany({
      select: {
        id: true,
        name: true,
        manufacturer: true,
        model: true,
        type: true,
        caliber: true,
        nfaTransferMethod: true,
        nfaControlNumber: true,
        nfaApprovalDate: true,
        nfaTaxPaid: true,
        nfaRegisteredTo: true,
        acquisitionDate: true,
        purchasePrice: true,
        notes: true,
        imageUrl: true,
      },
      orderBy: [{ manufacturer: "asc" }, { name: "asc" }],
    })) as AccessoryExportRecord[];
    const documents = (exportOptions.includeDocuments
      ? await findDocumentsForExport()
      : []) as ExportDocumentRecord[];
    const ammoStocks = (exportOptions.includeAmmo
      ? await prisma.ammoStock.findMany({
          select: {
            id: true,
            brand: true,
            caliber: true,
            quantity: true,
            lowStockAlert: true,
            purchasePrice: true,
            notes: true,
          },
          orderBy: [{ caliber: "asc" }, { brand: "asc" }],
        })
      : []) as ExportAmmoRecord[];
    const gearItems = (await prisma.gear.findMany({
      select: {
        id: true,
        name: true,
        manufacturer: true,
        model: true,
        serialNumber: true,
        category: true,
        quantity: true,
        purchasePrice: true,
        currentValue: true,
        acquisitionDate: true,
        expirationDate: true,
        protectionLevel: true,
        armorSize: true,
        storageLocation: true,
        notes: true,
        imageUrl: true,
      },
      orderBy: [{ manufacturer: "asc" }, { name: "asc" }],
    })) as GearExportRecord[];

    // Resolved once, not per row: expiryStatus must never read the clock
    // itself, matching getSupplySectionItems.ts's own resolution of "today".
    //
    // The whole context, not just `today`, because meta's footnote has to name
    // the timezone and the day that THESE rows were judged against. A second
    // `new Date()` or a second AppSettings read for the footnote is exactly how
    // a disclosure line ends up contradicting the rows it annotates.
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const expiry = resolveExpiryContext(settings, new Date());
    const today = expiry.today;
    const expiryWarningDays = expiry.warningDays;

    const supplies = (await prisma.supply.findMany({
      select: {
        id: true,
        name: true,
        brand: true,
        category: true,
        quantity: true,
        unit: true,
        lowStockAlert: true,
        expirationDate: true,
        purchasePrice: true,
        purchaseDate: true,
        storageLocation: true,
        notes: true,
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    })) as SupplyExportRecord[];

    // Sequential, after the supply read — SQLite here runs connection_limit=1,
    // so never Promise.all. ONE query for every kit with its lines included,
    // not one per kit: a KitItem row is a packing-list entry, so the whole
    // set comes back in a single round trip and the rollups run in memory.
    const kits = (await prisma.kit.findMany({
      select: {
        id: true,
        name: true,
        category: true,
        location: true,
        notes: true,
        items: {
          select: {
            quantity: true,
            targetQuantity: true,
            gear: { select: { expirationDate: true } },
            supply: { select: { expirationDate: true } },
          },
        },
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    })) as KitExportRecord[];

    const receiptDocuments = documents.filter((doc) => doc.type === "RECEIPT");

    const itemRows = [
      ...firearms.map((firearm) => {
        const itemDocs = documents.filter((doc) => doc.firearmId === firearm.id);
        const receiptCount = itemDocs.filter((doc) => doc.type === "RECEIPT").length;
        const hasPhoto = exportOptions.includeImages && !!firearm.imageUrl;
        const resolvedSerial = exportOptions.includeSerialNumbers
          ? (decryptField(firearm.serialNumber) ?? firearm.serialNumber ?? "")
          : "";

        return {
          itemId: firearm.id,
          entityType: "FIREARM" as const,
          category: firearm.type || "",
          nfaClass: firearmExportNfaClass(firearm),
          manufacturer: firearm.manufacturer || "",
          model: firearm.model || firearm.name,
          caliber: firearm.caliber || "",
          serialNumber: resolvedSerial,
          hasSerial: !!firearm.serialNumber,
          purchaseDate: toISODate(firearm.acquisitionDate),
          purchasePrice: exportOptions.includeValue ? (firearm.purchasePrice ?? null) : null,
          replacementValue: exportOptions.includeValue ? (firearm.currentValue ?? null) : null,
          receiptCount: exportOptions.includeDocuments ? receiptCount : 0,
          documentCount: exportOptions.includeDocuments ? itemDocs.length : 0,
          hasPhoto,
          imageUrl: hasPhoto ? firearm.imageUrl ?? "" : "",
          missingSerial: exportOptions.includeSerialNumbers ? !firearm.serialNumber : false,
          missingReceipt: exportOptions.includeDocuments ? receiptCount === 0 : false,
          missingPhoto: exportOptions.includeImages ? !hasPhoto : false,
          missingValue: exportOptions.includeValue
            ? firearm.currentValue == null && firearm.purchasePrice == null
            : false,
          notes: firearm.notes ?? "",
          ...nfaPaperworkColumns(
            firearm,
            exportOptions.includeSerialNumbers,
            exportOptions.includeValue
          ),
        };
      }),
      ...accessories.map((accessory) => {
        const itemDocs = documents.filter((doc) => doc.accessoryId === accessory.id);
        const receiptCount = itemDocs.filter((doc) => doc.type === "RECEIPT").length;
        const hasPhoto = exportOptions.includeImages && !!accessory.imageUrl;

        return {
          itemId: accessory.id,
          entityType: "ACCESSORY" as const,
          category: accessory.type || "",
          // An accessory has no class column on its model. Blank, not NONE:
          // "not applicable", as against a firearm's "Title I".
          nfaClass: "",
          manufacturer: accessory.manufacturer || "",
          model: accessory.model || accessory.name,
          caliber: accessory.caliber || "",
          serialNumber: "",
          hasSerial: false,
          purchaseDate: toISODate(accessory.acquisitionDate),
          purchasePrice: exportOptions.includeValue ? (accessory.purchasePrice ?? null) : null,
          replacementValue: null,
          receiptCount: exportOptions.includeDocuments ? receiptCount : 0,
          documentCount: exportOptions.includeDocuments ? itemDocs.length : 0,
          hasPhoto,
          imageUrl: hasPhoto ? accessory.imageUrl ?? "" : "",
          missingSerial: false,
          missingReceipt: exportOptions.includeDocuments ? receiptCount === 0 : false,
          missingPhoto: exportOptions.includeImages ? !hasPhoto : false,
          missingValue: exportOptions.includeValue ? accessory.purchasePrice == null : false,
          notes: accessory.notes ?? "",
          ...nfaPaperworkColumns(
            accessory,
            exportOptions.includeSerialNumbers,
            exportOptions.includeValue
          ),
        };
      }),
    ];

    const attachmentsRows: FullArmoryExportResponse["attachments"] = exportOptions.includeDocuments
      ? documents.map((doc) => {
          const linkedItemType: FullArmoryAttachmentRow["linkedItemType"] = doc.firearmId
            ? "FIREARM"
            : doc.accessoryId
              ? "ACCESSORY"
              : doc.gearId
                ? "GEAR"
                : "UNATTACHED";

          return {
            documentId: doc.id,
            type: doc.type,
            name: doc.name,
            linkedItemId: doc.firearmId || doc.accessoryId || doc.gearId || "",
            linkedItemType,
            linkedItemName: doc.firearm?.name || doc.accessory?.name || doc.gear?.name || "",
            mimeType: doc.mimeType ?? "",
            fileSize: doc.fileSize ?? "",
            fileUrl: doc.fileUrl,
            uploadedAt: doc.createdAt.toISOString(),
          };
        })
      : [];

    const ammoRows = exportOptions.includeAmmo
      ? ammoStocks.map((stock) => ({
          ammoId: stock.id,
          brand: stock.brand || "",
          caliber: stock.caliber || "",
          quantity: stock.quantity ?? 0,
          lowStockAlert: stock.lowStockAlert ?? null,
          purchasePrice: exportOptions.includeValue ? (stock.purchasePrice ?? null) : null,
          notes: stock.notes ?? "",
        }))
      : [];

    // Gear carries a serial, a value, documents and a photo, so every
    // missing-evidence counter applies to it exactly as it does to a firearm.
    // totalItems counts gear (below), so the counters must too — otherwise the
    // preview can say "13 items, 0 missing values" while a gear item has none.
    const gearRows = gearItems.map((item) => {
      const itemDocs = documents.filter((doc) => doc.gearId === item.id);
      const receiptCount = itemDocs.filter((doc) => doc.type === "RECEIPT").length;
      const hasPhoto = exportOptions.includeImages && !!item.imageUrl;

      return {
        gearId: item.id,
        name: item.name,
        category: gearCategoryLabel(item.category),
        manufacturer: item.manufacturer || "",
        model: item.model || "",
        serialNumber: exportOptions.includeSerialNumbers ? item.serialNumber || "" : "",
        quantity: item.quantity ?? 0,
        purchasePrice: exportOptions.includeValue ? (item.purchasePrice ?? null) : null,
        currentValue: exportOptions.includeValue ? (item.currentValue ?? null) : null,
        acquisitionDate: toISODate(item.acquisitionDate),
        expirationDate: toISODate(item.expirationDate),
        // The same `today` and window the supply rows below use, so one sheet
        // cannot carry two verdicts about the same calendar day — and the same
        // pair meta's footnote names.
        expiryStatus: expiryStatus(item.expirationDate, today, expiryWarningDays),
        // Three separate cells, not one. `category` says "Armor"; these say
        // what rating and what cut. Empty — not "—", not "null" — on every row
        // that has no rating, which is every non-armor row because the write
        // path clears both fields when a category stops being ARMOR. Not gated
        // on the category HERE, because a category this build does not
        // recognise keeps what it stored (normalizeGearArmorFields) and an
        // export is the last place that should quietly drop it.
        protectionLevel: item.protectionLevel || "",
        armorSize: item.armorSize || "",
        storageLocation: item.storageLocation || "",
        receiptCount: exportOptions.includeDocuments ? receiptCount : 0,
        documentCount: exportOptions.includeDocuments ? itemDocs.length : 0,
        hasPhoto,
        imageUrl: hasPhoto ? item.imageUrl ?? "" : "",
        missingSerial: exportOptions.includeSerialNumbers ? !item.serialNumber : false,
        missingReceipt: exportOptions.includeDocuments ? receiptCount === 0 : false,
        missingPhoto: exportOptions.includeImages ? !hasPhoto : false,
        missingValue: exportOptions.includeValue
          ? item.currentValue == null && item.purchasePrice == null
          : false,
        notes: item.notes ?? "",
      };
    });

    // A supply has no serial, no photo and no Document relation, so only
    // missingValue meaningfully applies to it — missingSerial/missingPhoto/
    // missingReceipt are not modelled on this row at all rather than
    // hardcoded false, because those concepts don't exist for a supply.
    // totalItems counts supplies (below) exactly as it counts gear, so
    // missingValues must too, for the same reason the gear fix applied:
    // the headline count and its missing counters have to share a
    // denominator or the preview can quote a "missing" figure computed over
    // a narrower set than the total it sits beside.
    const supplyRows = supplies.map((supply) => ({
      supplyId: supply.id,
      name: supply.name,
      brand: supply.brand || "",
      category: supplyCategoryLabel(supply.category),
      quantity: supply.quantity ?? 0,
      unit: supplyUnitLabel(supply.unit),
      lowStockAlert: supply.lowStockAlert ?? null,
      expirationDate: toISODate(supply.expirationDate),
      expiryStatus: expiryStatus(supply.expirationDate, today, expiryWarningDays),
      purchasePrice: exportOptions.includeValue ? (supply.purchasePrice ?? null) : null,
      purchaseDate: toISODate(supply.purchaseDate),
      storageLocation: supply.storageLocation || "",
      missingValue: exportOptions.includeValue ? supply.purchasePrice == null : false,
      notes: supply.notes ?? "",
    }));

    // A kit is a container: six values, six columns, and no price or serial at
    // all — its contents are already listed in full by the sections above, so
    // restating them here would double-count the armory. `missingCount` and
    // the expiry rollup come from the SAME pure helpers the kit detail page
    // and the section cards use (`missingQuantity`, `kitExpiryRollup`), which
    // in turn call the SAME `expiryStatus` against the SAME `today` the gear
    // and supply rows above were mapped with — so one sheet cannot carry two
    // verdicts about the same calendar day, and the footnote in meta names
    // that one day for these rows too.
    const kitRows = kits.map((kit) => {
      let missingCount = 0;
      const expiryLines: KitExpiryLine[] = [];
      for (const item of kit.items) {
        missingCount += missingQuantity(item);
        // A KitItem sets at most one source, so at most one of these is
        // non-null; `??` picks whichever it is. Accessory, AmmoStock, Firearm
        // and label-only lines have no expiry at all.
        const expirationDate =
          item.gear?.expirationDate ?? item.supply?.expirationDate ?? null;
        if (expirationDate) expiryLines.push({ expirationDate });
      }
      const rollup = kitExpiryRollup(expiryLines, today, expiryWarningDays);

      return {
        kitId: kit.id,
        name: kit.name,
        category: kitCategoryLabel(kit.category),
        location: kit.location || "",
        itemCount: kit.items.length,
        missingCount,
        earliestExpiry: toISODate(rollup.earliest),
        expiryStatus: expiryStatus(rollup.earliest, today, expiryWarningDays),
        expiredLineCount: rollup.expired,
        expiringSoonLineCount: rollup.soon,
        notes: kit.notes ?? "",
      };
    });

    // Accessories participate in totalItems and totalPurchaseValue but never carry a
    // replacementValue (their record has no currentValue field, so that row's
    // contribution is always 0). Gear does track currentValue, so it feeds all three
    // the same way firearms do. Supplies have a purchasePrice but no replacement-value
    // equivalent, so — like accessories — they feed totalPurchaseValue only.
    const totalPurchaseValue = exportOptions.includeValue
      ? itemRows.reduce((sum, item) => sum + (typeof item.purchasePrice === "number" ? item.purchasePrice : 0), 0) +
        gearRows.reduce((sum, item) => sum + (typeof item.purchasePrice === "number" ? item.purchasePrice : 0), 0) +
        supplyRows.reduce((sum, item) => sum + (typeof item.purchasePrice === "number" ? item.purchasePrice : 0), 0)
      : 0;

    const totalReplacementValue = exportOptions.includeValue
      ? itemRows.reduce((sum, item) => sum + (typeof item.replacementValue === "number" ? item.replacementValue : 0), 0) +
        gearRows.reduce((sum, item) => sum + (typeof item.currentValue === "number" ? item.currentValue : 0), 0)
      : 0;

    const payload: FullArmoryExportResponse = {
      meta: {
        generatedAt: new Date().toISOString(),
        preset,
        includesAllUploadedReceipts: exportOptions.includeDocuments,
        exportOptions,
        // Straight off the one resolved context the gear and supply rows were
        // mapped with — never re-resolved here.
        expiryTimezone: expiry.timezone,
        expiryTimezoneFromSetting: expiry.timezoneFromSetting,
        expiryEvaluatedOn: toISODate(today),
      },
      summary: {
        totalItems: itemRows.length + gearRows.length + supplyRows.length,
        totalFirearms: firearms.length,
        totalAccessories: accessories.length,
        totalGear: gearRows.length,
        totalSupplies: supplyRows.length,
        // Reported beside totalItems, never added into it — a kit's lines
        // point at rows already counted as gear, supplies, firearms,
        // accessories and ammo, so adding it would inflate the headline by
        // the number of bags the user owns.
        totalKits: kitRows.length,
        totalDocuments: attachmentsRows.length,
        totalReceipts: receiptDocuments.length,
        totalAmmoStocks: ammoRows.length,
        totalPurchaseValue,
        totalReplacementValue,
        missingEvidence: {
          missingReceipts:
            itemRows.filter((i) => i.missingReceipt).length + gearRows.filter((g) => g.missingReceipt).length,
          missingPhotos:
            itemRows.filter((i) => i.missingPhoto).length + gearRows.filter((g) => g.missingPhoto).length,
          missingValues:
            itemRows.filter((i) => i.missingValue).length +
            gearRows.filter((g) => g.missingValue).length +
            supplyRows.filter((s) => s.missingValue).length,
          missingSerials:
            itemRows.filter((i) => i.missingSerial).length + gearRows.filter((g) => g.missingSerial).length,
        },
      },
      items: itemRows,
      attachments: attachmentsRows,
      ammo: ammoRows,
      gear: gearRows,
      supplies: supplyRows,
      kits: kitRows,
    };

    if (format === "csv") {
      const csv = buildExportCsv(payload);
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${buildFileName("csv")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "pdf") {
      const pdf = buildSimplePdf(buildExportPdfLines(payload));
      return new NextResponse(pdf, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${buildFileName("pdf")}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/exports/full-armory error:", error);
    return NextResponse.json({ error: "Failed to generate full armory export" }, { status: 500 });
  }
}
