/**
 * Renders the REAL jsPDF document and reads the produced bytes back.
 *
 * This module had never executed once before this change — 410 lines with zero
 * callers — so "it compiles" and "the model looks right" were both worth very
 * little. jsPDF and pdf-lib both run in node, so the layout pass, the byte
 * output and the pdf-lib merge can all be exercised here; only the canvas image
 * path genuinely needs a browser, and that is verified separately by generating
 * a file from a real page and opening it.
 *
 * What the byte-level assertions buy that a model test cannot:
 *
 *  - The serial-exclusion test reads the FINISHED FILE. A model that withheld
 *    the serial but a renderer that printed it from somewhere else would pass
 *    the model test and fail this one.
 *  - The overflow test parses every text-placement operator out of the content
 *    streams and checks its x against the page edge. The renderer this replaces
 *    declared 652pt of document-index columns inside a 540pt content box and
 *    drew two of them past the edge of the paper on every row, which nothing
 *    short of looking at coordinates would have caught.
 */
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { buildFullArmoryPdf } from "@/lib/exports/full-armory-pdf";
import type {
  FullArmoryExportOptions,
  FullArmoryExportResponse,
} from "@/lib/exports/full-armory";

const SECRET_SERIAL = "ZZ-RENDER-5150";
const LETTER_WIDTH = 612;
const PAGE_MARGIN = 36;

function options(overrides: Partial<FullArmoryExportOptions> = {}): FullArmoryExportOptions {
  return {
    preset: "CLAIMS",
    includeSerialNumbers: true,
    includeAmmo: true,
    includeValue: true,
    // Off by default here: an image block needs a canvas, which node has not
    // got. The image path is verified in a browser.
    includeImages: false,
    includeDocuments: true,
    ...overrides,
  };
}

function payload(overrides: Partial<FullArmoryExportResponse> = {}): FullArmoryExportResponse {
  return {
    meta: {
      generatedAt: "2026-03-04T17:05:09.123Z",
      preset: "CLAIMS",
      includesAllUploadedReceipts: true,
      exportOptions: options(),
      expiryTimezone: "America/Denver",
      expiryTimezoneFromSetting: true,
      expiryEvaluatedOn: "2026-03-04",
    },
    summary: {
      totalItems: 1,
      totalFirearms: 1,
      totalAccessories: 0,
      totalGear: 0,
      totalSupplies: 0,
      totalKits: 0,
      totalDocuments: 1,
      totalReceipts: 1,
      totalAmmoStocks: 0,
      totalPurchaseValue: 2400,
      totalReplacementValue: 2900,
      missingEvidence: { missingReceipts: 0, missingPhotos: 1, missingValues: 0, missingSerials: 0 },
    },
    items: [
      {
        itemId: "item-1",
        entityType: "FIREARM",
        category: "RIFLE",
        manufacturer: "Knights Armament",
        model: "SR-15 Mod2 Carbine",
        caliber: "5.56 NATO",
        serialNumber: SECRET_SERIAL,
        hasSerial: true,
        purchaseDate: "2024-08-01",
        purchasePrice: 2400,
        replacementValue: 2900,
        receiptCount: 1,
        documentCount: 1,
        hasPhoto: false,
        imageUrl: "",
        missingSerial: false,
        missingReceipt: false,
        missingPhoto: true,
        missingValue: false,
        notes: "",
        nfaTransferMethod: "",
        nfaControlNumber: "",
        nfaApprovalDate: "",
        nfaTaxPaid: null,
        nfaRegisteredTo: "",
        nfaClass: "NONE",
      },
    ],
    attachments: [
      {
        documentId: "doc-1",
        type: "RECEIPT",
        name: "Purchase receipt",
        linkedItemId: "item-1",
        linkedItemType: "FIREARM",
        linkedItemName: "SR-15",
        mimeType: "application/pdf",
        fileSize: 1024,
        fileUrl: "/api/files/documents/receipt-1.pdf",
        uploadedAt: "2024-08-02T12:00:00.000Z",
      },
    ],
    ammo: [],
    gear: [],
    supplies: [],
    kits: [],
    ...overrides,
  };
}

/** A real two-page PDF, to stand in for a user's uploaded receipt. */
async function makeAttachmentPdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`ATTACHED RECEIPT PAGE ${index + 1}`, { x: 40, y: 700, size: 18, font });
  }
  return doc.save();
}

/** Every decompressed content stream in the file, concatenated. */
function contentStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes);
  const latin = raw.toString("latin1");
  let out = "";
  const pattern = /stream\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    const slice = raw.subarray(start, end);
    try {
      out += inflateSync(slice).toString("latin1");
    } catch {
      out += slice.toString("latin1");
    }
  }
  return out;
}

/**
 * The text of every text-showing operator in the file.
 *
 * Both string forms, because the file is written by two libraries: jsPDF emits
 * PDF literal strings — `(SR-15) Tj` — and pdf-lib emits hex strings —
 * `<53522d3135> Tj`. Reading only the literal form saw the laid-out pages and
 * none of the merged ones.
 */
function visibleText(bytes: Uint8Array): string {
  const streams = contentStreams(bytes);
  const shown: string[] = [];
  const pattern = /(?:\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>)\s*Tj/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(streams)) !== null) {
    if (match[1] !== undefined) {
      shown.push(match[1].replace(/\\([()\\])/g, "$1"));
    } else {
      const hex = (match[2] ?? "").replace(/\s+/g, "");
      shown.push(Buffer.from(hex, "hex").toString("latin1"));
    }
  }
  return shown.join("\n");
}

/** Every x coordinate a text run was placed at. */
function textOriginXs(bytes: Uint8Array): number[] {
  const streams = contentStreams(bytes);
  const xs: number[] = [];
  const pattern = /(-?[\d.]+)\s+(-?[\d.]+)\s+(?:Td|Tm)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(streams)) !== null) {
    xs.push(Number.parseFloat(match[1]));
  }
  // jsPDF emits `1 0 0 1 x y Tm`, so the Tm form's first two captured numbers
  // are the last of the six; the regex above takes the pair directly before the
  // operator either way.
  return xs.filter((value) => Number.isFinite(value));
}

async function bytesOf(
  data: FullArmoryExportResponse,
  opts: FullArmoryExportOptions
): Promise<{ bytes: Uint8Array; result: Awaited<ReturnType<typeof buildFullArmoryPdf>>["result"] }> {
  const { blob, result } = await buildFullArmoryPdf(data, opts);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), result };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildFullArmoryPdf — the produced file", () => {
  it("produces a file a PDF reader parses, with the expected pages and text", async () => {
    const { bytes, result } = await bytesOf(payload({ attachments: [] }), options());

    // Parsed by a real PDF implementation, not just "it is non-empty".
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(result.pageCount);
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");

    const text = visibleText(bytes);
    expect(text).toContain("Full Armory Export");
    expect(text).toContain("Master Inventory");
    expect(text).toContain("SR-15 Mod2 Carbine");
    expect(text).toContain("Expiry evaluated in America/Denver on 2026-03-04");
  });

  it("keeps every text run inside the printable width of the page", async () => {
    // The Document Index is the section that used to be drawn off the paper:
    // six fixed columns totalling 652pt in a 540pt box, with "File Ref"
    // starting at x=628 on a 612pt-wide page.
    const { bytes } = await bytesOf(payload(), options());

    const xs = textOriginXs(bytes);
    expect(xs.length).toBeGreaterThan(20);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(LETTER_WIDTH - PAGE_MARGIN + 1);
    }
  });

  it("paginates a long inventory instead of overprinting one page", async () => {
    const many = payload({ attachments: [] });
    many.items = Array.from({ length: 200 }, (_, index) => ({
      ...many.items[0],
      itemId: `item-${index}`,
      model: `Model ${index} with a deliberately very long descriptive name that will not fit`,
    }));

    const { result, bytes } = await bytesOf(many, options());
    expect(result.pageCount).toBeGreaterThan(2);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(result.pageCount);
    // The repeated table header proves the continuation pages are labelled.
    const headerOccurrences = visibleText(bytes).split("Manufacturer").length - 1;
    expect(headerOccurrences).toBeGreaterThan(1);
  });

  it("prints the serial when included and NOWHERE IN THE BYTES when excluded", async () => {
    const included = await bytesOf(payload({ attachments: [] }), options());
    expect(visibleText(included.bytes)).toContain(SECRET_SERIAL);

    // The payload still carries the serial; only the toggle changed. The route
    // blanks it server-side too, but this proves the renderer does not depend
    // on that.
    const excluded = await bytesOf(
      payload({ attachments: [] }),
      options({ includeSerialNumbers: false })
    );
    expect(visibleText(excluded.bytes)).not.toContain(SECRET_SERIAL);
    // Belt and braces: not anywhere in the raw file either, compressed streams
    // included.
    expect(contentStreams(excluded.bytes)).not.toContain(SECRET_SERIAL);
    expect(Buffer.from(excluded.bytes).toString("latin1")).not.toContain(SECRET_SERIAL);
  });

  it("renders an empty armory as a readable one-page packet, not a blank file", async () => {
    const empty = payload({ items: [], attachments: [], ammo: [], gear: [], supplies: [], kits: [] });
    empty.summary.totalItems = 0;

    const { bytes, result } = await bytesOf(empty, options());
    expect(result.pageCount).toBe(1);
    const text = visibleText(bytes);
    expect(text).toContain("Full Armory Export");
    expect(text).toContain("No firearms or accessories in this export.");
    expect(result.failedAttachments).toEqual([]);
  });
});

describe("buildFullArmoryPdf — merging attachments", () => {
  it("appends a label page and the attachment's pages", async () => {
    const attachment = await makeAttachmentPdf(2);
    vi.stubGlobal("fetch", async () => new Response(Buffer.from(attachment), { status: 200 }));

    const withoutMerge = await bytesOf(payload({ attachments: [] }), options());
    const merged = await bytesOf(payload(), options());

    // one label page + two attachment pages
    expect(merged.result.pageCount).toBe(withoutMerge.result.pageCount + 3);
    expect(merged.result.mergedAttachments).toBe(1);
    expect(merged.result.failedAttachments).toEqual([]);

    const parsed = await PDFDocument.load(merged.bytes);
    expect(parsed.getPageCount()).toBe(merged.result.pageCount);

    // Every page is the same size. pdf-lib's addPage() defaults to A4, so the
    // label page came out 595x842 in the middle of a run of 612x792 letter
    // pages until it was told otherwise — observed in a browser before it was
    // pinned here.
    for (const page of parsed.getPages()) {
      const { width, height } = page.getSize();
      expect([Math.round(width), Math.round(height)]).toEqual([612, 792]);
    }

    const text = visibleText(merged.bytes);
    expect(text).toContain("Document: Purchase receipt");
    expect(text).toContain("ATTACHED RECEIPT PAGE 1");
    expect(text).toContain("ATTACHED RECEIPT PAGE 2");
  });

  it("degrades to a complete packet when the attachment 404s", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));

    const baseline = await bytesOf(payload({ attachments: [] }), options());
    const { bytes, result } = await bytesOf(payload(), options());

    expect(result.failedAttachments).toEqual(["Purchase receipt"]);
    expect(result.mergedAttachments).toBe(0);
    // No orphan label page left behind — the count matches the un-merged doc.
    expect(result.pageCount).toBe(baseline.result.pageCount);
    expect(visibleText(bytes)).toContain("Full Armory Export");
  });

  it("degrades when a .pdf attachment is not actually a PDF", async () => {
    // The old code's bare `catch {}` would have swallowed this without telling
    // anyone, AND — because it added the label page before drawing on it —
    // could leave a blank page in the output.
    vi.stubGlobal("fetch", async () => new Response(Buffer.from("this is not a pdf at all"), { status: 200 }));

    const baseline = await bytesOf(payload({ attachments: [] }), options());
    const { bytes, result } = await bytesOf(payload(), options());

    expect(result.failedAttachments).toEqual(["Purchase receipt"]);
    expect(result.pageCount).toBe(baseline.result.pageCount);
    await expect(PDFDocument.load(bytes)).resolves.toBeDefined();
  });

  it("keeps the good attachments when one of several fails", async () => {
    const good = await makeAttachmentPdf(1);
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("bad")
        ? new Response("broken", { status: 500 })
        : new Response(Buffer.from(good), { status: 200 })
    );

    const data = payload();
    data.attachments = [
      { ...data.attachments[0], documentId: "d1", name: "Good receipt", fileUrl: "/files/good.pdf" },
      { ...data.attachments[0], documentId: "d2", name: "Bad receipt", fileUrl: "/files/bad.pdf" },
    ];

    const { bytes, result } = await bytesOf(data, options());
    expect(result.mergedAttachments).toBe(1);
    expect(result.failedAttachments).toEqual(["Bad receipt"]);
    expect(visibleText(bytes)).toContain("Document: Good receipt");
  });

  it("merges nothing at all when documents are excluded", async () => {
    const fetchSpy = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { result } = await bytesOf(payload(), options({ includeDocuments: false }));
    expect(result.mergedAttachments).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("survives an attachment name the PDF font cannot encode", async () => {
    // pdf-lib's default font THROWS on anything outside WinAnsi. The old code
    // called addPage() and then drawText() on the result, so the throw left a
    // blank page in the document and lost the attachment. Sanitising the text
    // means the attachment still merges.
    const attachment = await makeAttachmentPdf(1);
    vi.stubGlobal("fetch", async () => new Response(Buffer.from(attachment), { status: 200 }));

    const data = payload();
    data.attachments = [{ ...data.attachments[0], name: "Receipt \u{1F525}カタ" }];

    const { bytes, result } = await bytesOf(data, options());
    expect(result.mergedAttachments).toBe(1);
    expect(result.failedAttachments).toEqual([]);
    expect(visibleText(bytes)).toContain("ATTACHED RECEIPT PAGE 1");
  });
});
