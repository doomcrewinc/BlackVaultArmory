/**
 * The rich PDF export, as DATA.
 *
 * This module holds every string the rich PDF will ever print and none of the
 * drawing. It imports neither jspdf nor pdf-lib, which is the point three
 * times over:
 *
 *  1. It is testable in the node environment the rest of the suite runs in. The
 *     renderer needs a browser for canvas and a real reader to judge; the
 *     CONTENT does not, and the content is where this export has historically
 *     gone wrong.
 *  2. It gives the serial-number toggle ONE place to be enforced and one place
 *     to be checked. `collectModelText` walks the finished model and returns
 *     every string in it, so a test can assert that a withheld serial appears
 *     nowhere — not in a table cell, not in a heading, not in a caption, not
 *     nested two levels down inside a row of a table of a section. This repo
 *     has leaked serials four times, twice through nested objects; a test that
 *     only checked the one cell it remembered to look at is what let that
 *     happen.
 *  3. Keeping jspdf/pdf-lib behind a separate `"use client"` module that is
 *     only ever reached through a dynamic `import()` keeps both libraries out
 *     of the server bundle.
 */
import {
  formatExpiryFootnote,
  hasNfaPaperwork,
  nfaClassLabel,
  nfaTransferMethodLabel,
  type FullArmoryExportOptions,
  type FullArmoryExportResponse,
  type VisualEvidenceImage,
  selectVisualEvidence,
} from "@/lib/exports/full-armory";
import { formatCurrency } from "@/lib/utils";
import { formatTimestamp } from "@/lib/date";

/**
 * What a cell says when a toggle withheld the value, as opposed to when the
 * armory simply has nothing there.
 *
 * These are deliberately different strings. "—" on a serial column means "this
 * item has no serial recorded", which the Evidence Readiness counter above it
 * would then contradict by reporting zero missing serials. An adjuster reading
 * a dash has been told something false. "Withheld" says the user chose not to
 * publish it, which is the truth and is what the summary's counters were
 * computed against.
 */
export const WITHHELD = "Withheld";
export const EMPTY_CELL = "-";

/** A column of a table block: a heading and a share of the content width. */
export interface PdfColumn {
  label: string;
  /** Relative share of the available content width. Normalized at render. */
  weight: number;
  align?: "left" | "right";
}

export type PdfBlock =
  | { kind: "title"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "labelValue"; label: string; value: string }
  | { kind: "heading"; text: string }
  | { kind: "note"; text: string }
  | { kind: "spacer"; height: number }
  | { kind: "pageBreak" }
  | { kind: "table"; columns: PdfColumn[]; rows: string[][]; emptyText: string }
  | { kind: "image"; title: string; caption: string; imageUrl: string };

export interface FullArmoryPdfModel {
  filename: string;
  blocks: PdfBlock[];
  /**
   * The PDF attachments to merge after the laid-out pages, already filtered by
   * the includeDocuments toggle. Empty when the toggle is off, so the renderer
   * has no second chance to decide.
   */
  mergeTargets: Array<{ name: string; type: string; linkedItemName: string; fileUrl: string }>;
}

/**
 * jsPDF's standard fonts and pdf-lib's default font both encode a single byte
 * per character, and both handle anything outside that range badly: jsPDF
 * SILENTLY DROPS the character, and pdf-lib THROWS.
 *
 * That is not theoretical. The module this replaces printed `item.serialNumber
 * || "—"` and `formatCurrency(null)`, which returns "—", and truncated long
 * text with "…". Rendered through jsPDF, every one of those produced an EMPTY
 * CELL: verified by rendering an em-dash and an ellipsis and reading the `Tj`
 * operator back out of the bytes, which came out as `em-dash[] ellipsis[]`. So
 * an armory of items with no recorded price printed a column of blanks that
 * looked like a layout failure, and a truncated model name gave the reader no
 * sign it had been cut.
 *
 * On the pdf-lib side the same characters are worse than invisible. The label
 * page drawn before each merged attachment calls `drawText(attachment.name)`,
 * and a name carrying anything outside WinAnsi — an emoji, a CJK character —
 * throws mid-merge.
 *
 * So every string is folded to ASCII here before it reaches either library.
 * The common typographic characters get real replacements rather than being
 * dropped; anything else outside Latin-1 becomes "?" so the reader can see
 * that something was there.
 */
const TYPOGRAPHIC_REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―]/g, "-"],
  [/…/g, "..."],
  [/[•·]/g, "-"],
  [/ /g, " "],
  [/[‐‑‒]/g, "-"],
];

export function toPdfSafeText(value: string): string {
  let out = value ?? "";
  for (const [pattern, replacement] of TYPOGRAPHIC_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  // Drop control characters outright (a stray newline inside a table cell
  // would otherwise push the rest of the row off the baseline), and replace
  // anything still above ASCII with "?" rather than letting jsPDF erase it.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]/g, " ");
  return out.replace(/[^ -~]/g, "?");
}

/**
 * A cell value, resolved against the toggles.
 *
 * `present` is what the row actually holds; a blank one means the armory has
 * nothing there. `allowed` false means a toggle withheld it, and that wins over
 * everything: the value is never read.
 */
function cell(present: string | null | undefined, allowed = true): string {
  if (!allowed) return WITHHELD;
  const text = (present ?? "").trim();
  return text === "" ? EMPTY_CELL : text;
}

function money(value: number | null | undefined, allowed: boolean): string {
  if (!allowed) return WITHHELD;
  if (value == null) return EMPTY_CELL;
  return formatCurrency(value);
}

function toFileSafeTimestamp(isoDate: string): string {
  return String(isoDate ?? "").replace(/[:.]/g, "-");
}

/**
 * Whether a row is a PDF worth merging. Deliberately not keyed on
 * `type === "RECEIPT"`: the module this replaces had an `isPdfReceipt` helper
 * that demanded RECEIPT and then OR'd it with a plain mime/extension check, so
 * the RECEIPT arm never decided anything. A user's appraisal or bill of sale is
 * as mergeable as a receipt.
 */
export function isMergeablePdf(row: { mimeType?: string | null; fileUrl?: string | null }): boolean {
  if (!row.fileUrl) return false;
  if ((row.mimeType ?? "").toLowerCase() === "application/pdf") return true;
  return (row.fileUrl ?? "").toLowerCase().endsWith(".pdf");
}

/**
 * Build the whole document as data.
 *
 * Note what is here that the never-run module left out. `summary.totalItems` is
 * `firearms + accessories + gear + supplies`, but that module's only inventory
 * table listed firearms and accessories — so its cover page claimed a total the
 * pages behind it could not account for, and a user's armor, medical supplies
 * and packed kits were absent from an "adjuster-ready packet" entirely. The NFA
 * section is here for the same reason: `hasNfaPaperwork`'s own doc comment says
 * it is "shared by the PDF renderer and the preview's NFA Paperwork section",
 * and the PDF renderer never called it.
 */
export function buildFullArmoryPdfModel(
  payload: FullArmoryExportResponse,
  options: FullArmoryExportOptions
): FullArmoryPdfModel {
  const blocks: PdfBlock[] = [];
  const serials = options.includeSerialNumbers;
  const values = options.includeValue;

  blocks.push({ kind: "title", text: "Full Armory Export" });
  blocks.push({
    kind: "paragraph",
    text: "Adjuster-ready inventory packet generated from BlackVault.",
  });
  blocks.push({ kind: "spacer", height: 6 });

  // Date AND time, matching the preview's own "Generated" line. formatTimestamp
  // is date-only despite its name, and a packet that only says which day it was
  // produced loses the ordering between two exports taken the same afternoon.
  blocks.push({
    kind: "labelValue",
    label: "Generated",
    value: new Date(payload.meta.generatedAt).toLocaleString(),
  });
  blocks.push({ kind: "labelValue", label: "Preset", value: payload.meta.preset });
  blocks.push({ kind: "labelValue", label: "Total Items", value: String(payload.summary.totalItems) });
  blocks.push({
    kind: "labelValue",
    label: "Total Purchase",
    // Not formatCurrency(0). The route zeroes both totals when values are
    // excluded, so printing the number would tell an adjuster the armory is
    // worth nothing rather than that the user withheld the figures.
    value: values ? formatCurrency(payload.summary.totalPurchaseValue) : WITHHELD,
  });
  blocks.push({
    kind: "labelValue",
    label: "Total Replacement",
    value: values ? formatCurrency(payload.summary.totalReplacementValue) : WITHHELD,
  });
  blocks.push({
    kind: "labelValue",
    label: "Serial Numbers",
    value: serials ? "Included" : WITHHELD,
  });

  // The one sentence naming whose calendar day decided every expiry verdict in
  // this packet. formatExpiryFootnote's doc comment says every renderer — CSV,
  // PDF, the print preview — calls it so the wording cannot drift; the PDF was
  // the one that did not, and printed expiry-derived counts with no timezone
  // named at all.
  blocks.push({ kind: "note", text: formatExpiryFootnote(payload.meta) });
  blocks.push({ kind: "spacer", height: 8 });

  blocks.push({ kind: "heading", text: "Evidence Readiness" });
  blocks.push({
    kind: "paragraph",
    text: `Missing receipts: ${payload.summary.missingEvidence.missingReceipts}   |   Missing photos: ${payload.summary.missingEvidence.missingPhotos}`,
  });
  blocks.push({
    kind: "paragraph",
    text: `Missing values: ${payload.summary.missingEvidence.missingValues}   |   Missing serials: ${payload.summary.missingEvidence.missingSerials}`,
  });
  blocks.push({ kind: "spacer", height: 10 });

  blocks.push({ kind: "heading", text: "Master Inventory" });
  blocks.push({
    kind: "table",
    columns: [
      // Wide enough for the literal token. At weight 8 the column rendered
      // "ACCES..." for every accessory in the armory, observed in a browser.
      { label: "Type", weight: 11 },
      { label: "Platform", weight: 12 },
      { label: "Manufacturer", weight: 14 },
      { label: "Model", weight: 15 },
      // The widest text column of the three. A truncated model name costs the
      // reader a word; a truncated SERIAL is the one field an adjuster and a
      // police report have to match character for character, and a real serial
      // runs to fifteen-plus characters of wide uppercase.
      { label: "Serial", weight: 19 },
      { label: "Purchase", weight: 10, align: "right" },
      { label: "Replace", weight: 10, align: "right" },
      { label: "Docs", weight: 7, align: "right" },
    ],
    rows: payload.items.map((item) => [
      cell(item.entityType),
      cell(item.category),
      cell(item.manufacturer),
      cell(item.model),
      // The toggle is enforced HERE, on the client, even though the route
      // already blanks the column. Two independent gates on the same field,
      // because this payload is handed to the renderer by a caller that could
      // in principle have fetched it with different options than it renders
      // with, and a serial is the one field in this app where "it was probably
      // already stripped" has been wrong four times.
      cell(item.serialNumber, serials),
      money(item.purchasePrice, values),
      money(item.replacementValue, values),
      `${item.receiptCount}/${item.documentCount}`,
    ]),
    emptyText: "No firearms or accessories in this export.",
  });

  const nfaItems = payload.items.filter(hasNfaPaperwork);
  if (nfaItems.length > 0) {
    blocks.push({ kind: "spacer", height: 10 });
    blocks.push({ kind: "heading", text: "NFA Paperwork" });
    blocks.push({
      kind: "table",
      columns: [
        { label: "Item", weight: 22 },
        { label: "Class", weight: 13 },
        { label: "Transfer", weight: 14 },
        // nfaControlNumber is gated behind includeSerialNumbers server-side
        // because it identifies a registered item as precisely as a serial.
        // Gated again here for the same reason the serial column is.
        { label: "Control #", weight: 16 },
        { label: "Approved", weight: 12 },
        { label: "Tax", weight: 9, align: "right" },
        { label: "Registered To", weight: 14 },
      ],
      rows: nfaItems.map((item) => [
        cell(`${item.manufacturer} ${item.model}`.trim()),
        cell(nfaClassLabel(item.nfaClass)),
        cell(nfaTransferMethodLabel(item.nfaTransferMethod)),
        cell(item.nfaControlNumber, serials),
        cell(item.nfaApprovalDate),
        money(item.nfaTaxPaid, values),
        cell(item.nfaRegisteredTo),
      ]),
      emptyText: "No registered items.",
    });
  }

  if (payload.gear.length > 0) {
    blocks.push({ kind: "spacer", height: 10 });
    blocks.push({ kind: "heading", text: "Gear" });
    blocks.push({
      kind: "table",
      columns: [
        { label: "Category", weight: 10 },
        { label: "Name", weight: 16 },
        { label: "Manufacturer", weight: 12 },
        // Wide for the same reason the inventory's Serial column is: a gear
        // serial is verified character for character or not at all. Rendering
        // a real 16-character serial at the original width produced
        // "ZZSEED-GEAR..." in the browser, which is worse than useless on a
        // claim.
        { label: "Serial", weight: 18 },
        { label: "Qty", weight: 6, align: "right" },
        { label: "Purchase", weight: 11, align: "right" },
        { label: "Value", weight: 11, align: "right" },
        { label: "Expires", weight: 16 },
      ],
      rows: payload.gear.map((item) => [
        cell(item.category),
        cell(item.name),
        cell(item.manufacturer),
        cell(item.serialNumber, serials),
        String(item.quantity),
        money(item.purchasePrice, values),
        money(item.currentValue, values),
        item.expirationDate
          ? `${item.expirationDate} (${item.expiryStatus})`
          : EMPTY_CELL,
      ]),
      emptyText: "No gear in this export.",
    });
  }

  if (payload.supplies.length > 0) {
    blocks.push({ kind: "spacer", height: 10 });
    blocks.push({ kind: "heading", text: "Supplies" });
    blocks.push({
      kind: "table",
      columns: [
        { label: "Category", weight: 14 },
        { label: "Name", weight: 22 },
        { label: "Brand", weight: 15 },
        { label: "Qty", weight: 10, align: "right" },
        { label: "Purchase", weight: 12, align: "right" },
        { label: "Location", weight: 12 },
        { label: "Expires", weight: 15 },
      ],
      rows: payload.supplies.map((row) => [
        cell(row.category),
        cell(row.name),
        cell(row.brand),
        `${row.quantity} ${row.unit}`.trim(),
        money(row.purchasePrice, values),
        cell(row.storageLocation),
        row.expirationDate ? `${row.expirationDate} (${row.expiryStatus})` : EMPTY_CELL,
      ]),
      emptyText: "No supplies in this export.",
    });
  }

  if (payload.kits.length > 0) {
    blocks.push({ kind: "spacer", height: 10 });
    blocks.push({ kind: "heading", text: "Kits" });
    blocks.push({
      kind: "table",
      columns: [
        { label: "Kit", weight: 22 },
        { label: "Category", weight: 14 },
        { label: "Location", weight: 16 },
        { label: "Lines", weight: 8, align: "right" },
        { label: "Short", weight: 8, align: "right" },
        { label: "Earliest Expiry", weight: 18 },
        { label: "Expired/Soon", weight: 14, align: "right" },
      ],
      rows: payload.kits.map((kit) => [
        cell(kit.name),
        cell(kit.category),
        cell(kit.location),
        String(kit.itemCount),
        String(kit.missingCount),
        kit.earliestExpiry ? `${kit.earliestExpiry} (${kit.expiryStatus})` : EMPTY_CELL,
        `${kit.expiredLineCount}/${kit.expiringSoonLineCount}`,
      ]),
      emptyText: "No kits in this export.",
    });
    blocks.push({
      kind: "note",
      text: "Kits are containers: their lines point at rows listed in full above, so they are counted separately and add nothing to the item or value totals.",
    });
  }

  if (options.includeAmmo) {
    const ammoSummary = new Map<string, { totalRounds: number; stockEntries: number }>();
    for (const row of payload.ammo) {
      const key = row.caliber || "Unknown";
      const current = ammoSummary.get(key) ?? { totalRounds: 0, stockEntries: 0 };
      current.totalRounds += row.quantity;
      current.stockEntries += 1;
      ammoSummary.set(key, current);
    }

    if (ammoSummary.size > 0) {
      blocks.push({ kind: "spacer", height: 10 });
      blocks.push({ kind: "heading", text: "Ammo Summary" });
      blocks.push({
        kind: "table",
        columns: [
          { label: "Caliber", weight: 50 },
          { label: "Rounds", weight: 25, align: "right" },
          { label: "Stock Entries", weight: 25, align: "right" },
        ],
        rows: Array.from(ammoSummary.entries()).map(([caliber, row]) => [
          caliber,
          row.totalRounds.toLocaleString("en-US"),
          String(row.stockEntries),
        ]),
        emptyText: "No ammo in this export.",
      });
    }
  }

  const mergeTargets = options.includeDocuments
    ? payload.attachments.filter(isMergeablePdf).map((row) => ({
        name: row.name,
        type: row.type,
        linkedItemName: row.linkedItemName || "Unattached",
        fileUrl: row.fileUrl,
      }))
    : [];

  if (options.includeDocuments) {
    blocks.push({ kind: "spacer", height: 10 });
    blocks.push({ kind: "heading", text: "Document Index" });
    blocks.push({
      kind: "table",
      // Weights, not fixed point widths. The module this replaces declared six
      // fixed columns totalling 652pt inside a 540pt content box: "Uploaded"
      // began at x=558 and "File Ref" at x=628, the latter past the 612pt edge
      // of a letter page. Both columns were drawn off the paper on every single
      // row. Weights are normalized to the content width at render, so no
      // column can be placed off the page by construction.
      columns: [
        { label: "Type", weight: 10 },
        { label: "Name", weight: 26 },
        { label: "Linked Item", weight: 20 },
        { label: "Mime", weight: 14 },
        { label: "Uploaded", weight: 13 },
        { label: "File Ref", weight: 17 },
      ],
      rows: payload.attachments.map((row) => [
        cell(row.type),
        cell(row.name),
        cell(row.linkedItemName || row.linkedItemType),
        cell(row.mimeType),
        cell(formatTimestamp(row.uploadedAt)),
        cell(row.fileUrl),
      ]),
      emptyText: "No documents in this export.",
    });

    if (mergeTargets.length > 0) {
      blocks.push({
        kind: "note",
        text: `${mergeTargets.length} PDF document(s) are appended as additional pages at the end of this export.`,
      });
    }
  }

  const evidence: VisualEvidenceImage[] = selectVisualEvidence(payload, options);
  if (evidence.length > 0) {
    blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "heading", text: "Visual Evidence Appendix" });
    blocks.push({
      kind: "note",
      text: `Includes ${evidence.length} image(s) based on export options (images=${options.includeImages}, documents=${options.includeDocuments}).`,
    });
    for (const image of evidence) {
      blocks.push({
        kind: "image",
        title: image.title,
        caption: `${image.source} - ${image.linkedItemName || image.linkedItemId}`,
        imageUrl: image.imageUrl,
      });
    }
  }

  return {
    filename: `full-armory-export-${toFileSafeTimestamp(payload.meta.generatedAt)}.pdf`,
    blocks,
    mergeTargets,
  };
}

/**
 * EVERY string the model will print, flattened.
 *
 * This exists so a leak test does not have to know the document's shape. A test
 * that asserted "the serial column says Withheld" would pass while the same
 * serial rode along in a caption, a heading, or a row of a section added later
 * — which is the shape of the two nested-object leaks this project has already
 * had. Walking the model catches a new section for free: any block a future
 * change adds is a block this function already reads.
 *
 * imageUrl and the merge targets' fileUrls are included on purpose. They are
 * not printed as body text, but they are paths derived from stored records and
 * they end up in the file, so a leak test should see them too.
 */
export function collectModelText(model: FullArmoryPdfModel): string[] {
  const out: string[] = [model.filename];

  for (const block of model.blocks) {
    switch (block.kind) {
      case "title":
      case "paragraph":
      case "heading":
      case "note":
        out.push(block.text);
        break;
      case "labelValue":
        out.push(block.label, block.value);
        break;
      case "table":
        out.push(block.emptyText);
        for (const column of block.columns) out.push(column.label);
        for (const row of block.rows) out.push(...row);
        break;
      case "image":
        out.push(block.title, block.caption, block.imageUrl);
        break;
      case "spacer":
      case "pageBreak":
        break;
    }
  }

  for (const target of model.mergeTargets) {
    out.push(target.name, target.type, target.linkedItemName, target.fileUrl);
  }

  return out;
}
