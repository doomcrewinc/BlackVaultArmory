import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { DOCUMENT_OWNER_INCLUDE } from "@/lib/documents/owner-include";
import { documentsRoot, writeEncryptedFile } from "@/lib/files/storage";

export type DocumentOwners = {
  firearmId?: string | null;
  accessoryId?: string | null;
  gearId?: string | null;
  ammoStockId?: string | null;
  supplyId?: string | null;
  kitId?: string | null;
};

export type StoreDocumentInput = {
  bytes: Buffer;
  extension: string;
  mimeType: string;
  name: string;
  type: string;
  notes: string | null;
  owners: DocumentOwners;
};

/**
 * Writes the encrypted file under `documentsRoot()` and creates the Document
 * row in a transaction on the app client. The audit log records the actor of
 * an enclosing `auditStorage.run({ actor })`, else the request's. When the row
 * cannot be created the file is removed again.
 */
export async function storeDocument(input: StoreDocumentInput) {
  const fileName = `${randomUUID().replace(/-/g, "")}.${input.extension}`;
  const uploadDir = documentsRoot();
  const filePath = path.join(uploadDir, fileName);

  await fs.mkdir(uploadDir, { recursive: true });
  await writeEncryptedFile(filePath, input.bytes);

  const data = {
    name: input.name,
    type: input.type,
    fileUrl: `/api/files/documents/${fileName}`,
    fileSize: input.bytes.length,
    mimeType: input.mimeType,
    notes: input.notes,
    firearmId: input.owners.firearmId || null,
    accessoryId: input.owners.accessoryId || null,
    gearId: input.owners.gearId || null,
    ammoStockId: input.owners.ammoStockId || null,
    supplyId: input.owners.supplyId || null,
    kitId: input.owners.kitId || null,
  };

  try {
    return await prisma.$transaction(
      async (tx) => await tx.document.create({ data, include: DOCUMENT_OWNER_INCLUDE }),
    );
  } catch (e) {
    await fs.unlink(filePath).catch(() => undefined);
    throw e;
  }
}
