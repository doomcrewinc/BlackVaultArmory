"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Download, Loader2, Printer, RefreshCw } from "lucide-react";
import {
  buildExportQueryString,
  formatExpiryFootnote,
  hasNfaPaperwork,
  nfaClassLabel,
  nfaTransferMethodLabel,
  parseExportOptionsFromSearchParams,
  selectVisualEvidence,
  type FullArmoryExportResponse,
} from "@/lib/exports/full-armory";
import { formatCurrency } from "@/lib/utils";
import { formatDateOnly, formatTimestamp } from "@/lib/date";

export default function FullArmoryPreviewPage() {
  const [queryString, setQueryString] = useState("");
  const [data, setData] = useState<FullArmoryExportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The rich PDF download. Separate from `error` above, which is the page's own
  // data load: a failed export must not blank the preview the user is reading.
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfNotice, setPdfNotice] = useState<string | null>(null);

  useEffect(() => {
    setQueryString(window.location.search.replace(/^\?/, ""));
  }, []);

  const options = useMemo(
    () => parseExportOptionsFromSearchParams(new URLSearchParams(queryString)),
    [queryString]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const query = buildExportQueryString(options);
        const response = await fetch(`/api/exports/full-armory?${query}`, { signal: controller.signal });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.error ?? "Failed to load export preview");
        }
        setData(json);
      } catch (loadError) {
        if ((loadError as Error).name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load export preview");
      } finally {
        setLoading(false);
      }
    }

    void load();
    return () => controller.abort();
  }, [options]);

  /**
   * Build the rich PDF: a laid-out packet with the item photos embedded and the
   * user's own PDF receipts merged in behind it.
   *
   * The generator is reached through a dynamic import, not a static one, for
   * two reasons. jspdf and pdf-lib are together the largest dependencies in the
   * app and nothing else uses them, so a static import would put them in this
   * page's first-load bundle for every visitor who only wanted to read the
   * preview; and this is a client component, which Next also renders on the
   * server, so a static import would drag both libraries into the server bundle
   * as well. Behind an import() inside a handler they land in their own lazy
   * client chunk and appear in neither.
   *
   * This is deliberately ADDITIONAL to the server's own
   * `?format=pdf` export, which builds a dependency-free text-only PDF and is
   * untouched. Two different products for two different needs.
   */
  async function handleDownloadPdf() {
    if (!data || pdfBusy) return;
    setPdfBusy(true);
    setPdfError(null);
    setPdfNotice(null);
    try {
      const { generateFullArmoryPdf } = await import("@/lib/exports/full-armory-pdf");
      const result = await generateFullArmoryPdf(data, options);

      // Partial failures are reported, never swallowed. A user whose receipts
      // all failed to merge should not have to open the file to find out.
      const problems: string[] = [];
      if (result.failedAttachments.length > 0) {
        problems.push(
          `${result.failedAttachments.length} document(s) could not be merged: ${result.failedAttachments.join(", ")}`
        );
      }
      if (result.failedImages.length > 0) {
        problems.push(`${result.failedImages.length} image(s) could not be embedded`);
      }
      setPdfNotice(
        problems.length > 0
          ? `${result.filename} downloaded (${result.pageCount} pages). ${problems.join(". ")}.`
          : null
      );
    } catch (downloadError) {
      setPdfError(
        downloadError instanceof Error
          ? `Could not build the PDF: ${downloadError.message}`
          : "Could not build the PDF."
      );
    } finally {
      setPdfBusy(false);
    }
  }

  const visuals = useMemo(() => {
    if (!data) return [];
    return selectVisualEvidence(data, options);
  }, [data, options]);

  // The registered items, for the NFA Paperwork section below. Only the rows
  // that have paperwork: a section repeating "—" for every Title I firearm
  // would be longer than the inventory and say nothing.
  const nfaItems = useMemo(() => {
    if (!data) return [];
    return data.items.filter(hasNfaPaperwork);
  }, [data]);

  // The gear rows whose four screen-only columns have anything in them, for the
  // Gear Detail section — the same shape as nfaItems above, and for the same
  // reason: those columns do not fit on a letter page beside the other nine, and
  // a section repeating four dashes for every knife would be longer than the
  // Gear table and say nothing.
  const gearDetailItems = useMemo(() => {
    if (!data) return [];
    return data.gear.filter(
      (item) => item.protectionLevel || item.armorSize || item.storageLocation || item.notes
    );
  }, [data]);

  if (loading) {
    return (
      <main className="min-h-screen bg-vault-bg text-vault-text px-4 py-10">
        <div className="mx-auto max-w-4xl rounded-lg border border-vault-border bg-vault-surface p-6 flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading export preview...
        </div>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen bg-vault-bg text-vault-text px-4 py-10">
        <div className="mx-auto max-w-4xl rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-6 space-y-3">
          <p className="text-sm text-[#E53935]">{error ?? "Unable to load preview"}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 rounded-md border border-vault-border bg-vault-surface px-3 py-1.5 text-xs"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Retry
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-vault-bg text-vault-text px-4 py-8">
      <div className="armory-preview-print mx-auto max-w-5xl space-y-5">
        <section className="print:hidden rounded-lg border border-vault-border bg-vault-surface p-4 flex flex-wrap gap-2 items-center justify-between">
          <div>
            <p className="text-xs text-vault-text-faint uppercase tracking-widest font-mono">Preview Mode</p>
            <p className="text-sm text-vault-text-muted">
              Ready for insurance adjuster review. &quot;Download PDF&quot; builds a laid-out packet with photos
              and your PDF receipts merged in; &quot;Print / Save PDF&quot; prints this page as you see it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-2 rounded-md border border-vault-border bg-vault-surface px-3 py-2 text-xs text-vault-text-muted hover:text-vault-text"
            >
              <Printer className="h-3.5 w-3.5" />
              Print / Save PDF
            </button>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={pdfBusy}
              aria-busy={pdfBusy}
              className="inline-flex items-center gap-2 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-3 py-2 text-xs text-[#00C2FF] disabled:opacity-60"
            >
              {pdfBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {pdfBusy ? "Building PDF..." : "Download PDF"}
            </button>
          </div>
        </section>

        {pdfError ? (
          <section className="print:hidden rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-3">
            <p className="text-xs text-[#E53935]">{pdfError}</p>
          </section>
        ) : null}

        {pdfNotice ? (
          <section className="print:hidden rounded-lg border border-[#F5A623]/30 bg-[#F5A623]/10 p-3 flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-[#F5A623] mt-0.5 shrink-0" />
            <p className="text-xs text-[#F5A623]">{pdfNotice}</p>
          </section>
        ) : null}

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h1 className="text-lg font-semibold text-vault-text">Full Armory Export</h1>
          <p className="text-xs text-vault-text-faint mt-1">Generated {new Date(data.meta.generatedAt).toLocaleString()}</p>
          {/* The gear, supply AND kit tables below all carry an expiry verdict.
              This says whose calendar day decided them — the same sentence the
              CSV and the PDF print, from the same meta the rows came with, so
              the printout an adjuster reads cannot disagree with either. One
              sentence covers all three because all three verdicts came from the
              one context the route resolved; the kit rollup calls the same
              expiryStatus against the same today and reads no clock of its own. */}
          <p className="text-xs text-vault-text-faint mt-0.5">{formatExpiryFootnote(data.meta)}</p>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-vault-text-faint">Preset</p>
              <p className="font-semibold text-vault-text">{data.meta.preset}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-vault-text-faint">Total Items</p>
              <p className="font-semibold text-vault-text">{data.summary.totalItems}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-vault-text-faint">Purchase Total</p>
              <p className="font-semibold text-vault-text">{formatCurrency(data.summary.totalPurchaseValue)}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-vault-text-faint">Replacement Total</p>
              <p className="font-semibold text-vault-text">{formatCurrency(data.summary.totalReplacementValue)}</p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="px-2 py-1 rounded border border-vault-border">Serials: {options.includeSerialNumbers ? "Included" : "Hidden"}</span>
            <span className="px-2 py-1 rounded border border-vault-border">Ammo: {options.includeAmmo ? "Included" : "Excluded"}</span>
            <span className="px-2 py-1 rounded border border-vault-border">Value: {options.includeValue ? "Included" : "Excluded"}</span>
            <span className="px-2 py-1 rounded border border-vault-border">Images: {options.includeImages ? "Included" : "Excluded"}</span>
            <span className="px-2 py-1 rounded border border-vault-border">Documents: {options.includeDocuments ? "Included" : "Excluded"}</span>
          </div>
        </section>

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Evidence Readiness</h2>
          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-[11px] text-vault-text-faint">Missing Receipts</p>
              <p className="text-base font-semibold">{data.summary.missingEvidence.missingReceipts}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-[11px] text-vault-text-faint">Missing Photos</p>
              <p className="text-base font-semibold">{data.summary.missingEvidence.missingPhotos}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-[11px] text-vault-text-faint">Missing Values</p>
              <p className="text-base font-semibold">{data.summary.missingEvidence.missingValues}</p>
            </div>
            <div className="rounded-md border border-vault-border bg-vault-bg p-3">
              <p className="text-[11px] text-vault-text-faint">Missing Serials</p>
              <p className="text-base font-semibold">{data.summary.missingEvidence.missingSerials}</p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Master Inventory</h2>
          <div className="armory-print-scroll mt-3 overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-vault-border text-vault-text-faint">
                  <th className="py-2 pr-4 text-left">Type</th>
                  <th className="py-2 pr-4 text-left">Platform</th>
                  <th className="py-2 pr-4 text-left">NFA Class</th>
                  <th className="py-2 pr-4 text-left">Manufacturer</th>
                  <th className="py-2 pr-4 text-left">Model</th>
                  <th className="py-2 pr-4 text-left">Serial</th>
                  <th className="py-2 pr-4 text-right">Purchase</th>
                  <th className="py-2 pr-4 text-right">Replacement</th>
                  {/* The paperwork half of this table is screen-only: 14 columns
                      do not fit on letter paper, and an overflow-x-auto table does
                      not scroll on paper — it truncates, which silently dropped
                      every one of these columns out of the printout. In print they
                      are the NFA Paperwork section below instead. */}
                  <th className="print:hidden py-2 pr-4 text-left">Transfer Method</th>
                  <th className="print:hidden py-2 pr-4 text-left">Control Number</th>
                  <th className="print:hidden py-2 pr-4 text-left">Approval Date</th>
                  <th className="print:hidden py-2 pr-4 text-right">Tax Paid</th>
                  <th className="print:hidden py-2 pr-4 text-left">Registered To</th>
                  <th className="py-2 text-right">Docs</th>
                </tr>
              </thead>
              <tbody>
                {data.items.length === 0 ? (
                  <tr>
                    <td className="py-3 text-vault-text-faint" colSpan={14}>
                      No inventory items included for this export.
                    </td>
                  </tr>
                ) : (
                  data.items.map((item) => (
                    <tr key={item.itemId} className="border-b border-vault-border/60">
                      <td className="py-2 pr-4">{item.entityType}</td>
                      {/* Platform and class are separate columns: an SBR is a RIFLE by
                          platform and an SBR by law, and a claims sheet needs both. The
                          class cell shows the label the detail pages show, and a dash
                          for a Title I firearm or an accessory, which has no class. */}
                      <td className="py-2 pr-4">{item.category || "—"}</td>
                      <td className="py-2 pr-4">{nfaClassLabel(item.nfaClass) || "—"}</td>
                      <td className="py-2 pr-4">{item.manufacturer || "—"}</td>
                      <td className="py-2 pr-4">{item.model || "—"}</td>
                      <td className="py-2 pr-4 font-mono">{item.serialNumber || "—"}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.purchasePrice)}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.replacementValue)}</td>
                      <td className="print:hidden py-2 pr-4">{nfaTransferMethodLabel(item.nfaTransferMethod) || "—"}</td>
                      {/* Blanked with serials rather than dropped, the same as the
                          Serial cell — the dash means "withheld or none on file", and
                          the options badges above say which. */}
                      <td className="print:hidden py-2 pr-4 font-mono">{item.nfaControlNumber || "—"}</td>
                      <td className="print:hidden py-2 pr-4">{formatDateOnly(item.nfaApprovalDate)}</td>
                      <td className="print:hidden py-2 pr-4 text-right">{formatCurrency(item.nfaTaxPaid)}</td>
                      <td className="print:hidden py-2 pr-4">{item.nfaRegisteredTo || "—"}</td>
                      <td className="py-2 text-right">{item.receiptCount}/{item.documentCount}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {nfaItems.length > 0 && (
          <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">NFA Paperwork</h2>
            <p className="text-xs text-vault-text-faint mt-1">
              {nfaItems.length} registered {nfaItems.length === 1 ? "item" : "items"}. These columns also appear in
              Master Inventory on screen; on paper they live here, where they fit.
            </p>
            <div className="armory-print-scroll mt-3 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-vault-border text-vault-text-faint">
                    <th className="py-2 pr-4 text-left">Item</th>
                    <th className="py-2 pr-4 text-left">Platform</th>
                    <th className="py-2 pr-4 text-left">Class</th>
                    <th className="py-2 pr-4 text-left">Transfer Method</th>
                    <th className="py-2 pr-4 text-left">Control Number</th>
                    <th className="py-2 pr-4 text-left">Approval Date</th>
                    <th className="py-2 pr-4 text-right">Tax Paid</th>
                    <th className="py-2 text-left">Registered To</th>
                  </tr>
                </thead>
                <tbody>
                  {nfaItems.map((item) => (
                    <tr key={item.itemId} className="border-b border-vault-border/60 break-inside-avoid">
                      <td className="py-2 pr-4">
                        {[item.manufacturer, item.model].filter(Boolean).join(" ") || item.entityType}
                      </td>
                      <td className="py-2 pr-4">{item.category || "—"}</td>
                      {/* No fallback to the platform: a firearm carrying paperwork
                          with class NONE would otherwise print "RIFLE" under a
                          Class header, which is the misreading the separate class
                          column exists to remove. Platform has its own cell above,
                          so nothing is lost — an accessory reads SUPPRESSOR there
                          and a dash here, because it has no class. */}
                      <td className="py-2 pr-4">{nfaClassLabel(item.nfaClass) || "—"}</td>
                      <td className="py-2 pr-4">{nfaTransferMethodLabel(item.nfaTransferMethod) || "—"}</td>
                      <td className="py-2 pr-4 font-mono">{item.nfaControlNumber || "—"}</td>
                      <td className="py-2 pr-4">{formatDateOnly(item.nfaApprovalDate)}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.nfaTaxPaid)}</td>
                      <td className="py-2">{item.nfaRegisteredTo || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {options.includeAmmo && (
          <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Ammo Inventory</h2>
            <div className="armory-print-scroll mt-3 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-vault-border text-vault-text-faint">
                    <th className="py-2 text-left">Brand</th>
                    <th className="py-2 text-left">Caliber</th>
                    <th className="py-2 text-right">Quantity</th>
                    <th className="py-2 text-right">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {data.ammo.length === 0 ? (
                    <tr>
                      <td className="py-3 text-vault-text-faint" colSpan={4}>
                        No ammo records included for this export.
                      </td>
                    </tr>
                  ) : (
                    data.ammo.map((row) => (
                      <tr key={row.ammoId} className="border-b border-vault-border/60">
                        <td className="py-2">{row.brand || "—"}</td>
                        <td className="py-2">{row.caliber || "—"}</td>
                        <td className="py-2 text-right">{row.quantity}</td>
                        <td className="py-2 text-right">{formatCurrency(row.purchasePrice)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Gear</h2>
          <div className="armory-print-scroll mt-3 overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-vault-border text-vault-text-faint">
                  <th className="py-2 pr-4 text-left">Category</th>
                  <th className="py-2 pr-4 text-left">Name</th>
                  <th className="py-2 pr-4 text-left">Manufacturer</th>
                  <th className="py-2 pr-4 text-left">Model</th>
                  <th className="py-2 pr-4 text-left">Serial</th>
                  <th className="py-2 pr-4 text-right">Qty</th>
                  <th className="py-2 pr-4 text-right">Purchase</th>
                  <th className="py-2 pr-4 text-right">Value</th>
                  {/* Three separate columns, never folded together or into
                      Category. Phase 3 folded a firearm's platform into its NFA
                      class and printed "Class: PISTOL" for an SBR; a plate is
                      an Armor item rated NIJ III+ in a Medium SAPI cut, and a
                      claims sheet needs all three read separately. */}
                  <th className="py-2 pr-4 text-left">Expires</th>
                  {/* Screen-only, and NOT because they matter less: thirteen
                      columns measure 838px against the 654px a letter page
                      leaves for a table here, so on paper the last three ran
                      off the right edge and were cut — the phase-3 failure
                      exactly. They print in Gear Detail below instead, the
                      same split Master Inventory and NFA Paperwork use.
                      `Expires` stays in this table because every category can
                      carry a date and the nine remaining columns measure
                      591px, inside the page with room to spare. */}
                  <th className="print:hidden py-2 pr-4 text-left">Protection Level</th>
                  <th className="print:hidden py-2 pr-4 text-left">Size / Cut</th>
                  <th className="print:hidden py-2 pr-4 text-left">Storage</th>
                  <th className="print:hidden py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.gear.length === 0 ? (
                  <tr>
                    <td className="py-3 text-vault-text-faint" colSpan={13}>
                      No gear records included for this export.
                    </td>
                  </tr>
                ) : (
                  data.gear.map((item) => (
                    <tr key={item.gearId} className="border-b border-vault-border/60">
                      <td className="py-2 pr-4">{item.category}</td>
                      <td className="py-2 pr-4">{item.name}</td>
                      <td className="py-2 pr-4">{item.manufacturer || "—"}</td>
                      <td className="py-2 pr-4">{item.model || "—"}</td>
                      <td className="py-2 pr-4 font-mono">{item.serialNumber || "—"}</td>
                      <td className="py-2 pr-4 text-right">{item.quantity}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.purchasePrice)}</td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.currentValue)}</td>
                      {/* A knife has no rated life and no plate cut, so these
                          three cells are EMPTY on its row — not a dash, which
                          here means "on file but withheld or unknown", and
                          never the string "null". The expiry cell keeps the
                          dash convention the Supplies table uses, because a
                          missing date there is a gap in the record. */}
                      <td className="py-2 pr-4">
                        {item.expirationDate ? formatDateOnly(item.expirationDate) : "—"}
                        {item.expiryStatus !== "none" ? ` (${item.expiryStatus})` : ""}
                      </td>
                      <td className="print:hidden py-2 pr-4">{item.protectionLevel}</td>
                      <td className="print:hidden py-2 pr-4">{item.armorSize}</td>
                      <td className="print:hidden py-2 pr-4">{item.storageLocation || "—"}</td>
                      <td className="print:hidden py-2">{item.notes || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {gearDetailItems.length > 0 && (
          <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Gear Detail</h2>
            <p className="text-xs text-vault-text-faint mt-1">
              {gearDetailItems.length} {gearDetailItems.length === 1 ? "item" : "items"} with a rating, a cut, a
              location or a note. These columns also appear in Gear on screen; on paper they live here, where they
              fit.
            </p>
            <div className="armory-print-scroll mt-3 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-vault-border text-vault-text-faint">
                    <th className="py-2 pr-4 text-left">Item</th>
                    <th className="py-2 pr-4 text-left">Category</th>
                    <th className="py-2 pr-4 text-left">Protection Level</th>
                    <th className="py-2 pr-4 text-left">Size / Cut</th>
                    <th className="py-2 pr-4 text-left">Storage</th>
                    <th className="py-2 text-left">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {gearDetailItems.map((item) => (
                    <tr key={item.gearId} className="border-b border-vault-border/60 break-inside-avoid">
                      <td className="py-2 pr-4">{item.name}</td>
                      <td className="py-2 pr-4">{item.category}</td>
                      {/* Still empty rather than dashed on a non-armor row: the
                          rule does not change because the table did. */}
                      <td className="py-2 pr-4">{item.protectionLevel}</td>
                      <td className="py-2 pr-4">{item.armorSize}</td>
                      <td className="py-2 pr-4">{item.storageLocation || "—"}</td>
                      <td className="py-2">{item.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Supplies</h2>
          <div className="armory-print-scroll mt-3 overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-vault-border text-vault-text-faint">
                  <th className="py-2 pr-4 text-left">Category</th>
                  <th className="py-2 pr-4 text-left">Name</th>
                  <th className="py-2 pr-4 text-left">Brand</th>
                  <th className="py-2 pr-4 text-right">Qty</th>
                  <th className="py-2 pr-4 text-left">Unit</th>
                  <th className="py-2 pr-4 text-right">Threshold</th>
                  <th className="py-2 pr-4 text-left">Expiry</th>
                  <th className="py-2 pr-4 text-right">Price</th>
                  <th className="py-2 pr-4 text-left">Purchased</th>
                  <th className="py-2 pr-4 text-left">Storage</th>
                  <th className="py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.supplies.length === 0 ? (
                  <tr>
                    <td className="py-3 text-vault-text-faint" colSpan={11}>
                      No supply records included for this export.
                    </td>
                  </tr>
                ) : (
                  data.supplies.map((item) => (
                    <tr key={item.supplyId} className="border-b border-vault-border/60">
                      <td className="py-2 pr-4">{item.category}</td>
                      <td className="py-2 pr-4">{item.name}</td>
                      <td className="py-2 pr-4">{item.brand || "—"}</td>
                      <td className="py-2 pr-4 text-right">{item.quantity}</td>
                      <td className="py-2 pr-4">{item.unit}</td>
                      <td className="py-2 pr-4 text-right">{item.lowStockAlert ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {formatDateOnly(item.expirationDate)}
                        {item.expiryStatus !== "none" ? ` (${item.expiryStatus})` : ""}
                      </td>
                      <td className="py-2 pr-4 text-right">{formatCurrency(item.purchasePrice)}</td>
                      <td className="py-2 pr-4">{formatDateOnly(item.purchaseDate)}</td>
                      <td className="py-2 pr-4">{item.storageLocation || "—"}</td>
                      <td className="py-2">{item.notes || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Kits</h2>
          <p className="text-xs text-vault-text-faint mt-1">
            A kit is a packing list, not a copy: its contents are listed in full in the sections above. No
            prices or serials here — nine columns that say what each bag is, where it is, and what it is short of.
          </p>
          {/* MEASURED, not eyeballed. Phase 5's gear table ran 174px off a
              letter sheet and a reviewer logged it as merely "cramped", so
              this one was printed before it shipped: emulating @page letter
              (8.5in less 0.4in margins = 739.2px), max-width:none,
              overflow:visible and print:hidden, the nine columns below measure
              a min-content width of 536.66px against the 665px this section
              leaves for a table — 128px of slack, so NO print split is needed
              and every column prints.

              `data-print-measure` is the hook that measurement used; it is
              kept so the next person to add a column can re-run it rather than
              guess. Re-measure if a column is added: the clip threshold is
              min-content width, not the rendered width, because the table is
              w-full and only overflows once its cells cannot narrow further. */}
          <div className="armory-print-scroll mt-3 overflow-x-auto">
            <table className="w-full text-xs border-collapse" data-print-measure="kits">
              <thead>
                <tr className="border-b border-vault-border text-vault-text-faint">
                  {/* NINE columns, each one value. Phase 3 folded a firearm's
                      platform into its NFA class and printed "Class: PISTOL"
                      for an SBR; "Bugout Bag — 12 items (2 missing)" is the
                      same mistake in a nicer font. */}
                  <th className="py-2 pr-4 text-left">Name</th>
                  <th className="py-2 pr-4 text-left">Category</th>
                  <th className="py-2 pr-4 text-left">Location</th>
                  <th className="py-2 pr-4 text-right">Items</th>
                  <th className="py-2 pr-4 text-right">Missing</th>
                  <th className="py-2 pr-4 text-left">Earliest Expiry</th>
                  <th className="py-2 pr-4 text-right">Expired</th>
                  <th className="py-2 pr-4 text-right">Soon</th>
                  <th className="py-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.kits.length === 0 ? (
                  <tr>
                    <td className="py-3 text-vault-text-faint" colSpan={9}>
                      No kits included for this export.
                    </td>
                  </tr>
                ) : (
                  data.kits.map((item) => (
                    <tr key={item.kitId} className="border-b border-vault-border/60">
                      <td className="py-2 pr-4">{item.name}</td>
                      <td className="py-2 pr-4">{item.category}</td>
                      <td className="py-2 pr-4">{item.location || "—"}</td>
                      <td className="py-2 pr-4 text-right">{item.itemCount}</td>
                      <td className="py-2 pr-4 text-right">{item.missingCount}</td>
                      {/* A kit with nothing dated in it shows a dash, the same
                          convention the Supplies table uses for a missing
                          date: a gap in the record, not a withheld value. */}
                      <td className="py-2 pr-4">
                        {item.earliestExpiry ? formatDateOnly(item.earliestExpiry) : "—"}
                        {item.expiryStatus !== "none" ? ` (${item.expiryStatus})` : ""}
                      </td>
                      <td className="py-2 pr-4 text-right">{item.expiredLineCount}</td>
                      <td className="py-2 pr-4 text-right">{item.expiringSoonLineCount}</td>
                      <td className="py-2">{item.notes || "—"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {options.includeDocuments && (
          <section className="rounded-lg border border-vault-border bg-vault-surface p-5">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Document Index</h2>
            <div className="armory-print-scroll mt-3 overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b border-vault-border text-vault-text-faint">
                    <th className="py-2 text-left">Type</th>
                    <th className="py-2 text-left">Name</th>
                    <th className="py-2 text-left">Linked Item</th>
                    <th className="py-2 text-left">Mime</th>
                    <th className="py-2 text-left">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attachments.length === 0 ? (
                    <tr>
                      <td className="py-3 text-vault-text-faint" colSpan={5}>
                        No documents included for this export.
                      </td>
                    </tr>
                  ) : (
                    data.attachments.map((row) => (
                      <tr key={row.documentId} className="border-b border-vault-border/60">
                        <td className="py-2">{row.type}</td>
                        <td className="py-2">{row.name}</td>
                        <td className="py-2">{row.linkedItemName || row.linkedItemType}</td>
                        <td className="py-2">{row.mimeType || "—"}</td>
                        <td className="py-2">{formatTimestamp(row.uploadedAt)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {visuals.length > 0 && (
          <section className="rounded-lg border border-vault-border bg-vault-surface p-5 armory-page-break">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-vault-text-muted">Visual Evidence Appendix</h2>
            <p className="text-xs text-vault-text-faint mt-1">
              Includes {visuals.length} image entries based on current export toggles.
            </p>
            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {visuals.map((image) => (
                <figure key={image.id} className="rounded-md border border-vault-border bg-vault-bg p-3 break-inside-avoid">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.imageUrl} alt={image.title} className="w-full h-52 object-contain bg-black/20 rounded" />
                  <figcaption className="mt-2 text-[11px] text-vault-text-muted">
                    <p className="font-medium text-vault-text">{image.title}</p>
                    <p>{image.source} • {image.linkedItemName || image.linkedItemId}</p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
