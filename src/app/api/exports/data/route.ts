import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/server/auth";

type ExportFormat = "csv" | "pdf";
type UploadReferenceKind = "firearmImage" | "accessoryImage" | "gearImage" | "document";

type SectionFlags = {
  firearms: boolean;
  accessories: boolean;
  gear: boolean;
  builds: boolean;
  ammo: boolean;
  kits: boolean;
  rangeSessions: boolean;
  documents: boolean;
  settings: boolean;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

function parseBool(value: string | null, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function parseFlags(searchParams: URLSearchParams): SectionFlags {
  return {
    firearms: parseBool(searchParams.get("firearms"), true),
    accessories: parseBool(searchParams.get("accessories"), true),
    gear: parseBool(searchParams.get("gear"), true),
    builds: parseBool(searchParams.get("builds"), true),
    ammo: parseBool(searchParams.get("ammo"), true),
    kits: parseBool(searchParams.get("kits"), true),
    rangeSessions: parseBool(searchParams.get("rangeSessions"), true),
    documents: parseBool(searchParams.get("documents"), true),
    settings: parseBool(searchParams.get("settings"), false),
  };
}

function parseFormat(searchParams: URLSearchParams): ExportFormat {
  const format = (searchParams.get("format") ?? "csv").trim().toLowerCase();
  if (format === "csv" || format === "pdf") return format;
  throw new Error("INVALID_FORMAT");
}

function normalizeIncludeUploadReferences(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

// Firearm, Accessory and Gear are the only models this route emits that carry a
// serialNumber. None of them may keep it when includeSerialNumbers is off —
// including the Accessory rows nested inside a build's slots, and the Firearm,
// Accessory and Gear rows nested inside a kit's lines.
function withoutSerialNumber(row: object): Record<string, unknown> {
  const rest = { ...row } as Record<string, unknown>;
  delete rest.serialNumber;
  return rest;
}

/**
 * Strips `serialNumber` from EVERY nested object on every line of a kit.
 *
 * A KitItem points at one of five inventory tables, three of which carry a
 * serial (Firearm, Accessory, Gear). That is the same shape a build's slots
 * have — an inventory row embedded one level below a row this route already
 * strips — and it is the shape that leaked a serial twice in this epic, the
 * second time two levels deep through a build slot, past tests that checked
 * the top-level `accessories` array.
 *
 * So this does NOT name the three relations that happen to carry a serial
 * today. It walks every object-valued property of the line and strips the
 * field from each one, which also covers a sixth source kind added later and
 * a serial column added to Supply or AmmoStock. The field name is the one
 * invariant; the relation list is not.
 *
 * It is the SECOND line of defence, not the first: the query below asks for
 * `serialNumber` only when the export includes serials, so with the toggle
 * off the column never leaves the database. Both, because a narrow select is
 * invisible to a test with a mocked Prisma client and a JS strip is invisible
 * to a reader of the query — the whole-payload sweep needs one of them to be
 * provable and a real deployment deserves both.
 */
function withoutKitLineSerials(kit: object): Record<string, unknown> {
  const row = { ...kit } as Record<string, unknown>;
  const lines = Array.isArray(row.items) ? row.items : [];
  row.items = lines.map((line) => {
    if (!isFlatObject(line)) return line;
    const lineRow = withoutSerialNumber(line);
    for (const [key, value] of Object.entries(lineRow)) {
      if (isFlatObject(value)) lineRow[key] = withoutSerialNumber(value);
    }
    return lineRow;
  });
  return row;
}

function isLocalUploadUrl(url: string): boolean {
  if (!url.startsWith("/api/files/")) return false;
  if (url.includes("..")) return false;
  return true;
}

function toSerializable(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isFlatObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function flattenObject(
  value: Record<string, unknown>,
  out: Record<string, string>,
  prefix = ""
) {
  for (const [key, raw] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isFlatObject(raw)) {
      flattenObject(raw, out, path);
      continue;
    }
    out[path] = toSerializable(raw);
  }
}

function toCsvValue(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, "\"\"")}"`;
  }
  return value;
}

function buildCsv(sections: { section: string; rows: unknown }[]): string {
  const flattenedRows: Record<string, string>[] = [];

  for (const section of sections) {
    const sourceRows = Array.isArray(section.rows) ? section.rows : [section.rows];
    for (const sourceRow of sourceRows) {
      const row: Record<string, string> = { section: section.section };
      if (isFlatObject(sourceRow)) {
        flattenObject(sourceRow, row);
      } else {
        row.value = toSerializable(sourceRow);
      }
      flattenedRows.push(row);
    }
  }

  if (flattenedRows.length === 0) return "section\n";

  const headers = Array.from(
    flattenedRows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set<string>())
  );

  const orderedHeaders = ["section", ...headers.filter((h) => h !== "section").sort()];
  const lines = [
    orderedHeaders.join(","),
    ...flattenedRows.map((row) =>
      orderedHeaders.map((header) => toCsvValue(row[header] ?? "")).join(",")
    ),
  ];

  return lines.join("\n");
}

function sanitizePdfText(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "?");
}

function escapePdfText(value: string): string {
  return sanitizePdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(line: string, maxChars: number): string[] {
  if (!line) return [""];
  if (line.length <= maxChars) return [line];

  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [line.slice(0, maxChars)];

  const wrapped: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        wrapped.push(current);
        current = "";
      }
      for (let i = 0; i < word.length; i += maxChars) {
        wrapped.push(word.slice(i, i + maxChars));
      }
      continue;
    }

    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
    } else {
      wrapped.push(current);
      current = word;
    }
  }

  if (current) wrapped.push(current);
  return wrapped.length > 0 ? wrapped : [line];
}

function summarizeValue(value: unknown): string {
  if (value == null) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || "-";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : null;
    const id = typeof record.id === "string" ? record.id : null;
    if (name && id) return `${name} (${id})`;
    if (name) return name;
    if (id) return id;
    return "object";
  }
  return String(value);
}

function summarizeRow(row: unknown): string {
  if (!isFlatObject(row)) return summarizeValue(row);

  const entries = Object.entries(row);
  const maxFields = 10;
  const parts: string[] = [];

  for (let i = 0; i < entries.length && i < maxFields; i += 1) {
    const [key, value] = entries[i];
    parts.push(`${key}: ${summarizeValue(value)}`);
  }

  if (entries.length > maxFields) {
    parts.push(`... +${entries.length - maxFields} fields`);
  }

  return parts.join(" | ");
}

function asRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

function buildPdfLines(
  payload: Record<string, unknown>,
  flags: SectionFlags,
  includeSerialNumbers: boolean
): string[] {
  const meta = payload.meta as { exportedAt: string };
  const lines: string[] = [
    "BlackVault Data Export",
    `Generated: ${meta.exportedAt}`,
    "Format: PDF",
    `Include serial numbers: ${includeSerialNumbers ? "Yes" : "No"}`,
    "",
  ];

  const sections: { title: string; enabled: boolean; rows: unknown[] }[] = [
    { title: "Firearms", enabled: flags.firearms, rows: asRows(payload.firearms) },
    { title: "Accessories", enabled: flags.accessories, rows: asRows(payload.accessories) },
    { title: "Gear", enabled: flags.gear, rows: asRows(payload.gear) },
    { title: "Builds", enabled: flags.builds, rows: asRows(payload.builds) },
    { title: "Ammo Stocks", enabled: flags.ammo, rows: asRows(payload.ammoStocks) },
    { title: "Kits", enabled: flags.kits, rows: asRows(payload.kits) },
    { title: "Range Sessions", enabled: flags.rangeSessions, rows: asRows(payload.rangeSessions) },
    { title: "Documents", enabled: flags.documents, rows: asRows(payload.documents) },
    { title: "Settings", enabled: flags.settings, rows: asRows(payload.settings) },
  ];

  for (const section of sections) {
    if (!section.enabled) continue;

    lines.push(`${section.title} (${section.rows.length})`);

    if (section.rows.length === 0) {
      lines.push("  No records");
      lines.push("");
      continue;
    }

    section.rows.forEach((row, index) => {
      const summary = summarizeRow(row);
      const wrapped = wrapLine(`${index + 1}. ${summary}`, 96);
      wrapped.forEach((line, wrappedIndex) => {
        lines.push(wrappedIndex === 0 ? `  ${line}` : `     ${line}`);
      });
    });

    lines.push("");
  }

  return lines;
}

function buildSimplePdf(lines: string[]): string {
  const maxLinesPerPage = 46;
  const pages: string[][] = [];

  for (let i = 0; i < lines.length; i += maxLinesPerPage) {
    pages.push(lines.slice(i, i + maxLinesPerPage));
  }

  if (pages.length === 0) pages.push([""]);

  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("");

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

  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers.map((num) => `${num} 0 R`).join(" ")}] /Count ${pageObjectNumbers.length} >>`;

  for (let i = 0; i < pages.length; i += 1) {
    const pageObjNum = pageObjectNumbers[i];
    const contentObjNum = contentObjectNumbers[i];
    const pageLines = pages[i];

    const streamLines = [
      "BT",
      "/F1 10 Tf",
      "14 TL",
      "50 742 Td",
    ];

    pageLines.forEach((line, lineIndex) => {
      if (lineIndex > 0) streamLines.push("T*");
      streamLines.push(`(${escapePdfText(line)}) Tj`);
    });
    streamLines.push("ET");

    const stream = streamLines.join("\n");
    const streamLength = Buffer.byteLength(stream, "utf8");

    objects[pageObjNum - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`;
    objects[contentObjNum - 1] = `<< /Length ${streamLength} >>\nstream\n${stream}\nendstream`;
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

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const searchParams = request.nextUrl.searchParams;
    const flags = parseFlags(searchParams);
    const format = parseFormat(searchParams);
    const includeSerialNumbers = parseBool(searchParams.get("includeSerialNumbers"), false);
    const appSettings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const includeUploadReferences = normalizeIncludeUploadReferences(appSettings?.includeUploadsInBackup);

    const payload: Record<string, unknown> = {
      meta: {
        exportedAt: new Date().toISOString(),
        format,
        includeSerialNumbers,
        includeUploadReferences,
        sections: flags,
      },
    };

    // Sequential queries — SQLite connection_limit=1 cannot handle concurrent reads
    if (flags.firearms) {
      const rows = await prisma.firearm.findMany({ orderBy: [{ manufacturer: "asc" }, { model: "asc" }, { name: "asc" }] });
      payload.firearms = includeSerialNumbers ? rows : rows.map(withoutSerialNumber);
    }

    if (flags.accessories) {
      const rows = await prisma.accessory.findMany({ orderBy: [{ manufacturer: "asc" }, { name: "asc" }] });
      payload.accessories = includeSerialNumbers ? rows : rows.map(withoutSerialNumber);
    }

    // Gear carries a serialNumber, so it honours includeSerialNumbers the same
    // way firearms do — otherwise a knife's serial would ride along in an export
    // the user asked to strip serials from.
    if (flags.gear) {
      const rows = await prisma.gear.findMany({ orderBy: [{ category: "asc" }, { manufacturer: "asc" }, { name: "asc" }] });
      payload.gear = includeSerialNumbers ? rows : rows.map(withoutSerialNumber);
    }

    if (flags.builds) {
      const rows = await prisma.build.findMany({
        include: {
          slots: {
            include: { accessory: true },
            orderBy: { slotType: "asc" },
          },
        },
        orderBy: [{ firearmId: "asc" }, { name: "asc" }],
      });
      // A build slot embeds the whole Accessory row, so the same strip has to
      // reach one level down — otherwise an accessory mounted on a build keeps
      // the serial the top-level accessories section just dropped.
      payload.builds = includeSerialNumbers
        ? rows
        : rows.map((row) => ({
            ...row,
            slots: row.slots.map((slot) =>
              slot.accessory ? { ...slot, accessory: withoutSerialNumber(slot.accessory) } : slot
            ),
          }));
    }

    if (flags.ammo) {
      payload.ammoStocks = await prisma.ammoStock.findMany({
        include: {
          transactions: {
            orderBy: { transactedAt: "desc" },
          },
        },
        orderBy: [{ caliber: "asc" }, { brand: "asc" }],
      });
    }

    // A kit is a packing list: its lines point at inventory rows elsewhere, so
    // the export carries the line plus enough of the row it points at to name
    // it. Three of the five source tables carry a serial, and every relation
    // is narrowed by an explicit `select` that asks for `serialNumber` only
    // when the export includes serials — the same property that kept the
    // serial leak out of /api/search. `withoutKitLineSerials` then strips the
    // field from every nested object regardless; see its docblock for why both.
    if (flags.kits) {
      const rows = await prisma.kit.findMany({
        include: {
          items: {
            orderBy: { createdAt: "asc" },
            include: {
              gear: {
                select: {
                  id: true,
                  name: true,
                  manufacturer: true,
                  model: true,
                  category: true,
                  quantity: true,
                  expirationDate: true,
                  serialNumber: includeSerialNumbers,
                },
              },
              supply: {
                select: {
                  id: true,
                  name: true,
                  brand: true,
                  category: true,
                  quantity: true,
                  unit: true,
                  expirationDate: true,
                },
              },
              accessory: {
                select: {
                  id: true,
                  name: true,
                  manufacturer: true,
                  model: true,
                  type: true,
                  quantity: true,
                  serialNumber: includeSerialNumbers,
                },
              },
              ammoStock: {
                select: { id: true, brand: true, caliber: true, quantity: true },
              },
              firearm: {
                select: {
                  id: true,
                  name: true,
                  manufacturer: true,
                  model: true,
                  caliber: true,
                  type: true,
                  serialNumber: includeSerialNumbers,
                },
              },
            },
          },
        },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      });
      payload.kits = includeSerialNumbers ? rows : rows.map(withoutKitLineSerials);
    }

    if (flags.rangeSessions) {
      payload.rangeSessions = await prisma.rangeSession.findMany({
        include: {
          sessionDrills: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { setNumber: "asc" }] },
          ammoLinks: true,
        },
        orderBy: { sessionDate: "desc" },
      });
    }

    if (flags.documents) {
      payload.documents = await prisma.document.findMany({
        include: {
          firearm: { select: { id: true, name: true } },
          accessory: { select: { id: true, name: true } },
          gear: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    }

    if (flags.settings) {
      if (!appSettings) {
        payload.settings = null;
      } else {
        const settingsRecord = appSettings as Record<string, unknown>;
        payload.settings = {
          id: settingsRecord.id,
          defaultCurrency: settingsRecord.defaultCurrency,
          dataStoragePath: settingsRecord.dataStoragePath,
          createdAt: settingsRecord.createdAt,
          updatedAt: settingsRecord.updatedAt,
          includeUploadsInBackup: settingsRecord.includeUploadsInBackup,
          autoBackupEnabled: settingsRecord.autoBackupEnabled,
          autoBackupCadence: settingsRecord.autoBackupCadence,
        };
      }
    }

    if (includeUploadReferences) {
      const uploadReferences: Array<Record<string, string>> = [];
      const seenReferenceKeys = new Set<string>();

      const addReference = (kind: UploadReferenceKind, sourceId: string, url: string) => {
        const normalizedSourceId = sourceId.trim();
        const normalizedUrl = url.trim();
        if (!normalizedSourceId) return;
        if (!isLocalUploadUrl(normalizedUrl)) return;
        const dedupeKey = `${kind}:${normalizedSourceId}:${normalizedUrl}`;
        if (seenReferenceKeys.has(dedupeKey)) return;
        seenReferenceKeys.add(dedupeKey);
        uploadReferences.push({
          kind,
          sourceId: normalizedSourceId,
          url: normalizedUrl,
          storagePath: normalizedUrl.replace("/api/files/", "storage/uploads/"),
        });
      };

      if (flags.firearms) {
        (payload.firearms as Array<Record<string, unknown>> | undefined)?.forEach((row) => {
          const id = String(row.id ?? "");
          const imageUrl = typeof row.imageUrl === "string" ? row.imageUrl : "";
          addReference("firearmImage", id, imageUrl);
        });
      }

      if (flags.accessories) {
        (payload.accessories as Array<Record<string, unknown>> | undefined)?.forEach((row) => {
          const id = String(row.id ?? "");
          const imageUrl = typeof row.imageUrl === "string" ? row.imageUrl : "";
          addReference("accessoryImage", id, imageUrl);
        });
      }

      if (flags.gear) {
        (payload.gear as Array<Record<string, unknown>> | undefined)?.forEach((row) => {
          const id = String(row.id ?? "");
          const imageUrl = typeof row.imageUrl === "string" ? row.imageUrl : "";
          addReference("gearImage", id, imageUrl);
        });
      }

      if (flags.documents) {
        (payload.documents as Array<Record<string, unknown>> | undefined)?.forEach((row) => {
          const id = String(row.id ?? "");
          const fileUrl = typeof row.fileUrl === "string" ? row.fileUrl : "";
          addReference("document", id, fileUrl);
        });
      }

      payload.uploadedAssetReferences = uploadReferences;
      payload.backupStorageGuidance = {
        summary:
          "Uploaded files live under storage/uploads. Copy that folder together with this export JSON/CSV file.",
        volumeHint:
          "Docker hint: mount a persistent host path to /app/storage (example: ./storage:/app/storage) so uploads and backups survive container rebuilds.",
      };
    }

    if (format === "pdf") {
      const pdfLines = buildPdfLines(payload, flags, includeSerialNumbers);
      const pdf = buildSimplePdf(pdfLines);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      return new NextResponse(pdf, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="blackvault-export-${timestamp}.pdf"`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (format === "csv") {
      const csvSections: { section: string; rows: unknown }[] = [
        {
          section: "meta",
          rows: {
            exportedAt: (payload.meta as { exportedAt: string }).exportedAt,
            format,
            includeSerialNumbers,
            includeUploadReferences,
            sections: flags,
          },
        },
      ];

      if (flags.firearms) csvSections.push({ section: "firearms", rows: payload.firearms ?? [] });
      if (flags.accessories) csvSections.push({ section: "accessories", rows: payload.accessories ?? [] });
      if (flags.gear) csvSections.push({ section: "gear", rows: payload.gear ?? [] });
      if (flags.builds) csvSections.push({ section: "builds", rows: payload.builds ?? [] });
      if (flags.ammo) csvSections.push({ section: "ammoStocks", rows: payload.ammoStocks ?? [] });
      if (flags.kits) csvSections.push({ section: "kits", rows: payload.kits ?? [] });
      if (flags.rangeSessions) csvSections.push({ section: "rangeSessions", rows: payload.rangeSessions ?? [] });
      if (flags.documents) csvSections.push({ section: "documents", rows: payload.documents ?? [] });
      if (flags.settings) csvSections.push({ section: "settings", rows: payload.settings ?? [] });
      if (includeUploadReferences) {
        csvSections.push({ section: "uploadedAssetReferences", rows: payload.uploadedAssetReferences ?? [] });
        csvSections.push({ section: "backupStorageGuidance", rows: payload.backupStorageGuidance ?? {} });
      }

      const csv = buildCsv(csvSections);
      return new NextResponse(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_FORMAT") {
      return NextResponse.json(
        { error: "Invalid format. Supported values: csv, pdf" },
        { status: 400 }
      );
    }
    console.error("GET /api/exports/data error:", error);
    return NextResponse.json({ error: "Failed to build export" }, { status: 500 });
  }
}
