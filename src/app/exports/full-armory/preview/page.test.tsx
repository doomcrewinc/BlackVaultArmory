// @vitest-environment jsdom
/**
 * Component test for the preview page's "Download PDF" control.
 *
 * WHAT THIS CAN AND CANNOT COVER. jsdom has no canvas and no PDF reader, so it
 * cannot render or judge a PDF — the file itself is verified two other ways:
 * full-armory-pdf.render.test.ts renders the real jsPDF document in node and
 * reads the produced bytes back, and the image path is verified by generating a
 * file from a real browser against a seeded armory.
 *
 * What is left over is precisely the wiring, and the wiring is where a module
 * with zero callers fails: is the generator reached at all, is it handed the
 * SAME options the preview was built with, and — the part the old module made
 * impossible — does a failure reach the user instead of ending as a silent
 * nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const generateFullArmoryPdf = vi.fn();
vi.mock("@/lib/exports/full-armory-pdf", () => ({ generateFullArmoryPdf }));

import FullArmoryPreviewPage from "./page";

const EXPORT_PAYLOAD = {
  meta: {
    generatedAt: "2026-03-04T17:05:09.123Z",
    preset: "CLAIMS",
    includesAllUploadedReceipts: true,
    exportOptions: {},
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
    totalDocuments: 0,
    totalReceipts: 0,
    totalAmmoStocks: 0,
    totalPurchaseValue: 2400,
    totalReplacementValue: 2900,
    missingEvidence: { missingReceipts: 0, missingPhotos: 0, missingValues: 0, missingSerials: 0 },
  },
  items: [
    {
      itemId: "item-1",
      entityType: "FIREARM",
      category: "RIFLE",
      manufacturer: "Knights Armament",
      model: "SR-15",
      caliber: "5.56 NATO",
      serialNumber: "SR15-0001",
      hasSerial: true,
      purchaseDate: "2024-08-01",
      purchasePrice: 2400,
      replacementValue: 2900,
      receiptCount: 0,
      documentCount: 0,
      hasPhoto: false,
      imageUrl: "",
      missingSerial: false,
      missingReceipt: false,
      missingPhoto: false,
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
  attachments: [],
  ammo: [],
  gear: [],
  supplies: [],
  kits: [],
};

const OK_RESULT = {
  filename: "full-armory-export-2026-03-04T17-05-09-123Z.pdf",
  pageCount: 2,
  mergedAttachments: 0,
  failedAttachments: [],
  embeddedImages: 0,
  failedImages: [],
};

function setSearch(search: string) {
  window.history.replaceState({}, "", `/exports/full-armory/preview${search}`);
}

beforeEach(() => {
  generateFullArmoryPdf.mockReset();
  generateFullArmoryPdf.mockResolvedValue(OK_RESULT);
  setSearch("");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(EXPORT_PAYLOAD), { status: 200 }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderLoaded() {
  render(<FullArmoryPreviewPage />);
  await screen.findByRole("button", { name: /download pdf/i });
}

describe("Full Armory preview — Download PDF", () => {
  it("offers the control once the preview has loaded", async () => {
    await renderLoaded();
    expect(screen.getByRole("button", { name: /download pdf/i })).toBeEnabled();
    // The existing print-to-PDF control is still there: the rich export is an
    // addition, not a replacement.
    expect(screen.getByRole("button", { name: /print \/ save pdf/i })).toBeInTheDocument();
  });

  it("builds the PDF with the SAME options the preview was rendered from", async () => {
    // A packet generated with different toggles than the page on screen is how
    // a withheld serial reaches a file, so this pins the two together.
    setSearch("?preset=BACKUP&includeSerialNumbers=false&includeValue=false&includeImages=false");
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));

    await waitFor(() => expect(generateFullArmoryPdf).toHaveBeenCalledTimes(1));
    const [, passedOptions] = generateFullArmoryPdf.mock.calls[0];
    expect(passedOptions).toEqual({
      preset: "BACKUP",
      includeSerialNumbers: false,
      includeAmmo: true,
      includeValue: false,
      includeImages: false,
      includeDocuments: true,
    });
  });

  it("shows an error instead of failing silently when the build throws", async () => {
    generateFullArmoryPdf.mockRejectedValue(new Error("jsPDF exploded"));
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));

    expect(await screen.findByText(/Could not build the PDF: jsPDF exploded/)).toBeInTheDocument();
    // And the preview itself is still on screen — a failed download must not
    // blank the page the user is reading.
    expect(screen.getByText("Master Inventory")).toBeInTheDocument();
  });

  it("names the attachments that could not be merged", async () => {
    // The module this wires up swallowed every merge failure in a bare catch.
    generateFullArmoryPdf.mockResolvedValue({
      ...OK_RESULT,
      failedAttachments: ["Bill of sale"],
      failedImages: ["FIREARM: Knights Armament SR-15"],
    });
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));

    const notice = await screen.findByText(/could not be merged: Bill of sale/);
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/1 image\(s\) could not be embedded/);
  });

  it("says nothing when everything worked", async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));

    await waitFor(() => expect(generateFullArmoryPdf).toHaveBeenCalled());
    expect(screen.queryByText(/could not be merged/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not build the PDF/)).not.toBeInTheDocument();
  });

  it("disables the control while a build is in flight, so one click is one file", async () => {
    let release: (value: typeof OK_RESULT) => void = () => {};
    generateFullArmoryPdf.mockReturnValue(
      new Promise<typeof OK_RESULT>((resolve) => {
        release = resolve;
      })
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: /download pdf/i }));

    const busy = await screen.findByRole("button", { name: /building pdf/i });
    expect(busy).toBeDisabled();

    fireEvent.click(busy);
    expect(generateFullArmoryPdf).toHaveBeenCalledTimes(1);

    release(OK_RESULT);
    await waitFor(() => expect(screen.getByRole("button", { name: /download pdf/i })).toBeEnabled());
  });
});
