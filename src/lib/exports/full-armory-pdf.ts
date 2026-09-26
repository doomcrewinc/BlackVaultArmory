"use client";

/**
 * The rich PDF renderer: laid out with jsPDF, item photos embedded, and the
 * user's own PDF receipts merged in behind it with pdf-lib.
 *
 * This is the BROWSER half of the export. The content lives in
 * full-armory-pdf-model.ts, which imports neither library and is unit-tested in
 * node; everything here needs a DOM (canvas to decode and re-encode images, a
 * Blob and an anchor to hand the file over) and is verified in a real browser
 * against a real reader.
 *
 * It is NOT the only PDF path and does not replace one. `GET
 * /api/exports/full-armory?format=pdf` builds a dependency-free, text-only PDF
 * server-side and is untouched by this file. This is the richer, optional one
 * the preview page offers.
 *
 * Reached only through `await import()` from a click handler, so jspdf and
 * pdf-lib land in a lazy client chunk and never in the server bundle.
 */

// Type-only: erased at compile time, so naming jsPDF here does not pull the
// library into this module's runtime graph. The value is loaded with a dynamic
// import() inside the functions that need it.
import type { jsPDF } from "jspdf";
import type { FullArmoryExportOptions, FullArmoryExportResponse } from "@/lib/exports/full-armory";
import {
  buildFullArmoryPdfModel,
  toPdfSafeText,
  type FullArmoryPdfModel,
  type PdfBlock,
  type PdfColumn,
} from "@/lib/exports/full-armory-pdf-model";

const PAGE_MARGIN = 36;
const FONT_SIZE_BODY = 9;
const FONT_SIZE_SMALL = 8;
const FONT_SIZE_HEADING = 11;
const FONT_SIZE_TITLE = 18;
const LINE_HEIGHT = 12;
const ROW_HEIGHT = 11;
const CELL_PAD = 3;

/**
 * What actually happened, so the caller can tell the user.
 *
 * The module this replaces returned `void` and swallowed every per-attachment
 * failure in a bare `catch {}`. A user whose three receipts all failed to merge
 * got a PDF that silently did not contain them and no way to find out. These
 * counts are what the preview page reports back on screen.
 */
export interface FullArmoryPdfResult {
  filename: string;
  pageCount: number;
  mergedAttachments: number;
  /** Attachment names whose PDF could not be fetched, parsed or copied. */
  failedAttachments: string[];
  embeddedImages: number;
  /** Image titles that could not be fetched or decoded. */
  failedImages: string[];
}

interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Fetch an image and re-encode it to JPEG through a canvas, which is also what
 * normalizes every format the browser can decode (png, webp, avif, gif) into
 * the one format jsPDF is reliably good at.
 *
 * Returns null rather than throwing on every failure mode there is: a 404, a
 * 401 from the auth-gated document route, a response that is not an image at
 * all, bytes the browser cannot decode, a canvas the browser refuses to read
 * back. The caller prints a visible "unable to embed" line in place of the
 * picture, so a broken photo costs one line of the packet and not the packet.
 */
async function loadImageForPdf(url: string): Promise<LoadedImage | null> {
  let objectUrl: string | null = null;
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) return null;

    const blob = await response.blob();
    // Trust the bytes over the header. /uploads/[...path] sets a correct
    // Content-Type but /api/files/documents/[fileName] falls back to
    // application/octet-stream for anything it does not recognise, and the
    // old code rejected on the header alone — so a perfectly decodable image
    // served by the document route was dropped before the browser ever looked
    // at it. An explicitly non-image type is still a fast reject.
    const type = blob.type.toLowerCase();
    if (type && !type.startsWith("image/") && type !== "application/octet-stream") return null;
    if (blob.size === 0) return null;

    objectUrl = URL.createObjectURL(blob);
    const source = objectUrl;
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode failed"));
      img.src = source;
    });

    if (!image.width || !image.height) return null;

    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // A transparent PNG flattened to JPEG goes black without this.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    if (!dataUrl.startsWith("data:image/jpeg")) return null;
    return { dataUrl, width, height };
  } catch {
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/** Cut a string to the widest prefix that fits, with a visible "..." marker. */
function fitText(doc: jsPDF, raw: string, maxWidth: number): string {
  const text = toPdfSafeText(raw);
  if (maxWidth <= 0) return "";
  if (doc.getTextWidth(text) <= maxWidth) return text;

  const ellipsis = "...";
  const ellipsisWidth = doc.getTextWidth(ellipsis);
  if (ellipsisWidth > maxWidth) return "";

  // Binary search rather than a fixed character budget. The old code truncated
  // by a hardcoded maxChars per column, which is a guess about average glyph
  // width: "IIIIIIIIIIIIIIII" and "WWWWWWWWWWWWWWWW" are both 16 characters and
  // differ by more than double in Helvetica, so the same budget both clipped
  // narrow text early and let wide text run into the next column.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (doc.getTextWidth(text.slice(0, mid)) + ellipsisWidth <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}${ellipsis}`;
}

/** Normalize a table's column weights onto the available content width. */
function layoutColumns(columns: PdfColumn[], contentWidth: number) {
  const total = columns.reduce((sum, column) => sum + Math.max(column.weight, 0), 0) || 1;
  let x = 0;
  return columns.map((column) => {
    const width = (Math.max(column.weight, 0) / total) * contentWidth;
    const placed = { column, x, width };
    x += width;
    return placed;
  });
}

function renderModel(
  doc: jsPDF,
  model: FullArmoryPdfModel,
  images: Map<string, LoadedImage | null>
): { embeddedImages: number; failedImages: string[] } {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN * 2;
  const bottom = pageHeight - PAGE_MARGIN;

  let y = PAGE_MARGIN + LINE_HEIGHT;
  let embeddedImages = 0;
  const failedImages: string[] = [];

  const newPage = () => {
    doc.addPage();
    y = PAGE_MARGIN + LINE_HEIGHT;
  };

  /**
   * Reserve vertical space, breaking to a new page if it does not fit, and say
   * whether it broke.
   *
   * The old code inferred "did we just break?" by comparing `y === PAGE_MARGIN`
   * after the fact — an exact float comparison against a constant that only
   * held because the break path happened to assign that exact constant. Any
   * change to the break path (a running header, a different top inset) would
   * have silently stopped every repeated table header from being drawn, with no
   * error anywhere. Returning the fact is not inferrable-wrong.
   */
  const ensureSpace = (required: number): boolean => {
    if (y + required <= bottom) return false;
    newPage();
    return true;
  };

  const drawTableHeader = (placed: ReturnType<typeof layoutColumns>) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(FONT_SIZE_SMALL);
    for (const { column, x, width } of placed) {
      const label = fitText(doc, column.label, width - CELL_PAD * 2);
      if (column.align === "right") {
        doc.text(label, PAGE_MARGIN + x + width - CELL_PAD, y, { align: "right" });
      } else {
        doc.text(label, PAGE_MARGIN + x + CELL_PAD, y);
      }
    }
    y += 4;
    doc.setDrawColor(150);
    doc.setLineWidth(0.5);
    doc.line(PAGE_MARGIN, y, PAGE_MARGIN + contentWidth, y);
    y += ROW_HEIGHT;
    doc.setFont("helvetica", "normal");
  };

  for (const block of model.blocks) {
    switch (block.kind) {
      case "title": {
        ensureSpace(FONT_SIZE_TITLE + 6);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(FONT_SIZE_TITLE);
        doc.text(toPdfSafeText(block.text), PAGE_MARGIN, y);
        y += FONT_SIZE_TITLE + 6;
        break;
      }
      case "heading": {
        ensureSpace(FONT_SIZE_HEADING + 8);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(FONT_SIZE_HEADING);
        doc.text(toPdfSafeText(block.text), PAGE_MARGIN, y);
        y += FONT_SIZE_HEADING + 5;
        break;
      }
      case "paragraph":
      case "note": {
        doc.setFont("helvetica", block.kind === "note" ? "italic" : "normal");
        doc.setFontSize(block.kind === "note" ? FONT_SIZE_SMALL : FONT_SIZE_BODY);
        // splitTextToSize wraps rather than clipping. The old code drew every
        // paragraph as a single unwrapped doc.text call, so a long sentence ran
        // straight off the right edge of the paper.
        const lines = doc.splitTextToSize(toPdfSafeText(block.text), contentWidth) as string[];
        for (const line of lines) {
          ensureSpace(LINE_HEIGHT);
          doc.text(line, PAGE_MARGIN, y);
          y += LINE_HEIGHT;
        }
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FONT_SIZE_BODY);
        break;
      }
      case "labelValue": {
        ensureSpace(LINE_HEIGHT);
        doc.setFontSize(FONT_SIZE_BODY);
        doc.setFont("helvetica", "bold");
        doc.text(`${toPdfSafeText(block.label)}:`, PAGE_MARGIN, y);
        doc.setFont("helvetica", "normal");
        doc.text(fitText(doc, block.value, contentWidth - 110), PAGE_MARGIN + 110, y);
        y += LINE_HEIGHT;
        break;
      }
      case "spacer": {
        y += block.height;
        break;
      }
      case "pageBreak": {
        newPage();
        break;
      }
      case "table": {
        const placed = layoutColumns(block.columns, contentWidth);
        ensureSpace(ROW_HEIGHT * 3);
        drawTableHeader(placed);

        if (block.rows.length === 0) {
          doc.setFont("helvetica", "italic");
          doc.setFontSize(FONT_SIZE_SMALL);
          doc.text(toPdfSafeText(block.emptyText), PAGE_MARGIN + CELL_PAD, y);
          y += ROW_HEIGHT;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(FONT_SIZE_BODY);
          break;
        }

        doc.setFontSize(FONT_SIZE_SMALL);
        for (const row of block.rows) {
          // A table that spills onto a second page repeats its header there.
          // Without it the continuation is an unlabelled grid of numbers.
          if (ensureSpace(ROW_HEIGHT)) drawTableHeader(placed);
          for (let index = 0; index < placed.length; index += 1) {
            const { column, x, width } = placed[index];
            const value = row[index] ?? "";
            const text = fitText(doc, value, width - CELL_PAD * 2);
            if (column.align === "right") {
              doc.text(text, PAGE_MARGIN + x + width - CELL_PAD, y, { align: "right" });
            } else {
              doc.text(text, PAGE_MARGIN + x + CELL_PAD, y);
            }
          }
          y += ROW_HEIGHT;
        }
        doc.setFontSize(FONT_SIZE_BODY);
        break;
      }
      case "image": {
        const loaded = images.get(block.imageUrl);

        doc.setFont("helvetica", "bold");
        doc.setFontSize(FONT_SIZE_BODY);
        const captionBlockHeight = LINE_HEIGHT * 2 + 6;

        if (!loaded) {
          failedImages.push(block.title);
          ensureSpace(captionBlockHeight + LINE_HEIGHT);
          doc.text(fitText(doc, block.title, contentWidth), PAGE_MARGIN, y);
          y += LINE_HEIGHT;
          doc.setFont("helvetica", "italic");
          doc.setFontSize(FONT_SIZE_SMALL);
          doc.text(fitText(doc, block.caption, contentWidth), PAGE_MARGIN, y);
          y += LINE_HEIGHT;
          doc.text("Unable to embed this image source.", PAGE_MARGIN, y);
          y += LINE_HEIGHT + 6;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(FONT_SIZE_BODY);
          break;
        }

        // Decide the rendered size BEFORE committing the caption to a page, so
        // a caption can never be orphaned at the foot of one page with its
        // photo at the head of the next — which is exactly what the old
        // "draw the caption, then check whether the image fits" order did.
        const aspect = loaded.height / loaded.width;
        const maxImageHeight = 420;
        let renderWidth = contentWidth;
        let renderHeight = renderWidth * aspect;
        if (renderHeight > maxImageHeight) {
          renderHeight = maxImageHeight;
          renderWidth = renderHeight / aspect;
        }

        const needed = captionBlockHeight + renderHeight + 10;
        const usablePageHeight = bottom - (PAGE_MARGIN + LINE_HEIGHT);
        if (needed > usablePageHeight) {
          // Taller than a whole empty page even at the cap: shrink to fit one.
          renderHeight = usablePageHeight - captionBlockHeight - 10;
          renderWidth = Math.min(contentWidth, renderHeight / aspect);
        }
        ensureSpace(captionBlockHeight + renderHeight + 10);

        doc.text(fitText(doc, block.title, contentWidth), PAGE_MARGIN, y);
        y += LINE_HEIGHT;
        doc.setFont("helvetica", "italic");
        doc.setFontSize(FONT_SIZE_SMALL);
        doc.text(fitText(doc, block.caption, contentWidth), PAGE_MARGIN, y);
        y += LINE_HEIGHT;
        doc.setFont("helvetica", "normal");
        doc.setFontSize(FONT_SIZE_BODY);

        doc.addImage(loaded.dataUrl, "JPEG", PAGE_MARGIN, y, renderWidth, renderHeight, undefined, "FAST");
        embeddedImages += 1;
        y += renderHeight + 10;
        break;
      }
    }
  }

  return { embeddedImages, failedImages };
}

/**
 * Append each PDF attachment behind a one-line label page.
 *
 * Every failure here is per-attachment and non-fatal: a 404, an encrypted file,
 * an .pdf-named file that is not a PDF at all, a page pdf-lib cannot copy. The
 * name goes into `failedAttachments` so the user is told which ones are
 * missing, instead of the old bare `catch {}` that lost them silently.
 */
async function mergeAttachments(
  mainPdfBytes: ArrayBuffer,
  targets: FullArmoryPdfModel["mergeTargets"]
): Promise<{ bytes: Uint8Array; merged: number; failed: string[] }> {
  const { PDFDocument } = await import("pdf-lib");
  const mergedDoc = await PDFDocument.load(mainPdfBytes);
  const firstPage = mergedDoc.getPage(0);
  const { width: pageWidth, height: pageHeight } = firstPage.getSize();
  const failed: string[] = [];
  let merged = 0;

  for (const attachment of targets) {
    try {
      const response = await fetch(attachment.fileUrl, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      const attachedPdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const indices = attachedPdf.getPageIndices();
      if (indices.length === 0) throw new Error("no pages");
      const copiedPages = await mergedDoc.copyPages(attachedPdf, indices);

      // The label page is added LAST-BUT-FIRST on purpose: build and draw it
      // before it is attached to the document. The old code called addPage()
      // and then drawText() on the result, so a name pdf-lib's default font
      // could not encode threw AFTER the blank page was already in the
      // document — the catch dropped the attachment and left a blank page
      // behind it. Every string here also goes through toPdfSafeText, which
      // removes the encoding throw as a possibility in the first place.
      // Sized to match the packet, not pdf-lib's A4 default. Verified in a
      // browser: the label page came out 595x842 in the middle of a run of
      // 612x792 letter pages, which a reader shows as a visibly different
      // sheet and a printer shrinks to fit.
      const labelPage = mergedDoc.addPage([pageWidth, pageHeight]);
      try {
        const height = pageHeight;
        labelPage.drawText(toPdfSafeText(`Document: ${attachment.name}`).slice(0, 90), {
          x: 36,
          y: height - 60,
          size: 14,
        });
        labelPage.drawText(
          toPdfSafeText(`Type: ${attachment.type}  |  Linked to: ${attachment.linkedItemName}`).slice(0, 110),
          { x: 36, y: height - 80, size: 10 }
        );
      } catch {
        mergedDoc.removePage(mergedDoc.getPageCount() - 1);
        throw new Error("label page failed");
      }

      for (const page of copiedPages) mergedDoc.addPage(page);
      merged += 1;
    } catch {
      failed.push(attachment.name);
    }
  }

  return { bytes: await mergedDoc.save(), merged, failed };
}

/**
 * Build the rich PDF and return it as a Blob, without touching the DOM's
 * download machinery. Split out from the download so a caller can inspect what
 * came back.
 */
export async function buildFullArmoryPdf(
  payload: FullArmoryExportResponse,
  options: FullArmoryExportOptions
): Promise<{ blob: Blob; result: FullArmoryPdfResult }> {
  const { jsPDF } = await import("jspdf");
  const model = buildFullArmoryPdfModel(payload, options);

  // Fetch every image up front and de-duplicate by URL: the same receipt image
  // can be evidence for more than one row, and re-fetching and re-encoding it
  // per appearance is the difference between a fast export and a stalled tab.
  const imageBlocks = model.blocks.filter((block): block is Extract<PdfBlock, { kind: "image" }> =>
    block.kind === "image"
  );
  const images = new Map<string, LoadedImage | null>();
  for (const block of imageBlocks) {
    if (images.has(block.imageUrl)) continue;
    images.set(block.imageUrl, await loadImageForPdf(block.imageUrl));
  }

  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter", compress: true });
  const { embeddedImages, failedImages } = renderModel(doc, model, images);

  const mainBytes = doc.output("arraybuffer");

  if (model.mergeTargets.length === 0) {
    const blob = new Blob([new Uint8Array(mainBytes)], { type: "application/pdf" });
    return {
      blob,
      result: {
        filename: model.filename,
        pageCount: doc.getNumberOfPages(),
        mergedAttachments: 0,
        failedAttachments: [],
        embeddedImages,
        failedImages,
      },
    };
  }

  const { bytes, merged, failed } = await mergeAttachments(mainBytes, model.mergeTargets);
  // Copied into a plain Uint8Array over a concrete ArrayBuffer: pdf-lib can
  // hand back a view onto a SharedArrayBuffer-typed buffer, which Blob rejects
  // in some TypeScript/DOM lib combinations.
  const safeBytes = new Uint8Array(bytes);
  const blob = new Blob([safeBytes], { type: "application/pdf" });

  const { PDFDocument } = await import("pdf-lib");
  let pageCount = doc.getNumberOfPages();
  try {
    pageCount = (await PDFDocument.load(safeBytes)).getPageCount();
  } catch {
    // Reporting a slightly stale page count is not worth failing the export.
  }

  return {
    blob,
    result: {
      filename: model.filename,
      pageCount,
      mergedAttachments: merged,
      failedAttachments: failed,
      embeddedImages,
      failedImages,
    },
  };
}

/**
 * Build the rich PDF and hand it to the browser.
 *
 * Throws only when the document could not be produced at all. Partial failures
 * — an unreadable photo, an attachment that would not merge — come back in the
 * result so the caller can say which ones, and the user still gets the packet.
 */
export async function generateFullArmoryPdf(
  payload: FullArmoryExportResponse,
  options: FullArmoryExportOptions
): Promise<FullArmoryPdfResult> {
  const { blob, result } = await buildFullArmoryPdf(payload, options);

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  anchor.rel = "noopener";
  // Appended, and the object URL revoked on a later tick. A detached anchor
  // does not fire a download in Firefox, and revoking the URL in the same tick
  // as the click races the download in more than one browser — both of which
  // the old code did.
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 2000);

  return result;
}
