import type { PrismaClient } from "@prisma/client";
import type { AppPrismaClient } from "@/lib/prisma";

/**
 * Fixtures for the backup and restore tests: a firearm and an ammunition
 * stock, each with a gallery photo (an original and a preview file), and a
 * document on the ammunition stock. Shared by the two real-database suites.
 */

export interface GalleryPhoto {
  id: string;
  /** Uploads-relative paths of the two files. */
  original: string;
  preview: string;
  originalBytes: Buffer;
  previewBytes: Buffer;
  /** The owner column the row sets, and the owner's id. */
  ownerColumn: "firearmId" | "ammoStockId";
  ownerId: string;
}

export interface Gallery {
  firearmId: string;
  ammoStockId: string;
  documentId: string;
  documentPath: string;
  documentBytes: Buffer;
  photos: GalleryPhoto[];
}

/** Every uploads-relative file the gallery writes, with its plaintext. */
export function galleryFiles(g: Gallery): Array<[string, Buffer]> {
  return [
    ...g.photos.flatMap((p): Array<[string, Buffer]> => [[p.original, p.originalBytes], [p.preview, p.previewBytes]]),
    [g.documentPath, g.documentBytes],
  ];
}

const DB_ROW = { mimeType: "image/jpeg", fileSize: 64, width: 640, height: 480 };

export async function seedGallery(
  db: AppPrismaClient,
  put: (rel: string, bytes: Buffer) => Promise<unknown>,
): Promise<Gallery> {
  const firearm = await db.firearm.create({
    data: {
      name: "Gallery pistol",
      manufacturer: "Glock",
      model: "17",
      caliber: "9mm",
      serialNumber: "SER-GALLERY-1",
      type: "PISTOL",
      acquisitionDate: new Date("2024-02-02T00:00:00.000Z"),
    },
  });
  const ammo = await db.ammoStock.create({ data: { caliber: "9mm", brand: "Gallery Ammo", quantity: 100 } });
  const photos: GalleryPhoto[] = [
    ["gal-firearm", "firearmId", firearm.id],
    ["gal-ammo", "ammoStockId", ammo.id],
  ].map(([id, ownerColumn, ownerId]) => ({
    id,
    original: `images/photos/${id}.jpg`,
    preview: `images/photos/thumbs/${id}.webp`,
    originalBytes: Buffer.from(`original bytes of ${id} `.repeat(30)),
    previewBytes: Buffer.from(`preview bytes of ${id} `.repeat(10)),
    ownerColumn: ownerColumn as GalleryPhoto["ownerColumn"],
    ownerId,
  }));
  const documentBytes = Buffer.from("%PDF-1.4 receipt for the ammunition");
  const documentPath = "documents/gallery-receipt.pdf";
  for (const p of photos) {
    await put(p.original, p.originalBytes);
    await put(p.preview, p.previewBytes);
    await db.photo.create({
      data: { id: p.id, fileName: `${p.id}.jpg`, label: `label ${p.id}`, [p.ownerColumn]: p.ownerId, ...DB_ROW },
    });
  }
  await put(documentPath, documentBytes);
  const doc = await db.document.create({
    data: {
      name: "Ammo receipt",
      type: "RECEIPT",
      fileUrl: "/api/files/documents/gallery-receipt.pdf",
      ammoStockId: ammo.id,
    },
  });
  return { firearmId: firearm.id, ammoStockId: ammo.id, documentId: doc.id, documentPath, documentBytes, photos };
}

/** A capture pass (with the account and session it needs) for the given item. Returns the pass id. */
export async function seedPass(raw: PrismaClient, entityId: string): Promise<string> {
  const user =
    (await raw.user.findUnique({ where: { username: "gallery-user" } })) ??
    (await raw.user.create({ data: { username: "gallery-user", displayName: "Gallery", passwordHash: "x" } }));
  const session =
    (await raw.session.findUnique({ where: { tokenHash: "gallery-session" } })) ??
    (await raw.session.create({
      data: { userId: user.id, tokenHash: "gallery-session", expiresAt: new Date(Date.now() + 3_600_000) },
    }));
  const pass = await raw.capturePass.create({
    data: {
      tokenHash: `pass-${entityId}`,
      entityType: "ammo",
      entityId,
      createdById: user.id,
      sessionId: session.id,
      expiresAt: new Date(Date.now() + 900_000),
    },
  });
  return pass.id;
}

/** Removes everything seedGallery and seedPass made (photos go with their owners). */
export async function clearGallery(raw: PrismaClient, g: Gallery): Promise<void> {
  await raw.document.deleteMany({ where: { id: g.documentId } });
  await raw.ammoStock.deleteMany({ where: { id: g.ammoStockId } });
  await raw.firearm.deleteMany({ where: { id: g.firearmId } });
  await raw.user.deleteMany({ where: { username: "gallery-user" } }); // its sessions and passes go with it
}
