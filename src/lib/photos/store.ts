import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Photo, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { describeError } from "./errors";
import { uploadsRoot, writeEncryptedFile } from "@/lib/files/storage";
import { processPicture } from "@/lib/images/process";
import { OWNER_COLUMN, OWNER_DELEGATE, type PhotoEntityType } from "./owner";

const LABEL_MAX = 80;

export function photoUrl(fileName: string): string {
  return `/uploads/images/photos/${fileName}`;
}

export function previewUrl(id: string): string {
  return `/uploads/images/photos/thumbs/${id}.webp`;
}

export type PhotoDto = {
  id: string;
  url: string;
  previewUrl: string;
  label: string | null;
  width: number;
  height: number;
  fileSize: number;
  viaPass: boolean;
  createdAt: string;
  isMain: boolean;
};

export function toPhotoDto(photo: Photo, mainImageUrl: string | null): PhotoDto {
  const url = photoUrl(photo.fileName);
  return {
    id: photo.id,
    url,
    previewUrl: previewUrl(photo.id),
    label: photo.label,
    width: photo.width,
    height: photo.height,
    fileSize: photo.fileSize,
    viaPass: photo.viaPass,
    createdAt: photo.createdAt.toISOString(),
    isMain: mainImageUrl === url,
  };
}

/** Trims; empty becomes null; throws RangeError over 80 characters. */
export function normaliseLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (label === "") return null;
  if (label.length > LABEL_MAX) throw new RangeError(`Label is longer than ${LABEL_MAX} characters`);
  return label;
}

function photosDir(): string {
  return path.join(uploadsRoot(), "images", "photos");
}

function originalPath(fileName: string): string {
  return path.join(photosDir(), fileName);
}

function previewPath(id: string): string {
  return path.join(photosDir(), "thumbs", `${id}.webp`);
}

type ItemDelegate = {
  findUnique(args: { where: { id: string }; select: { imageUrl: true } }): Promise<{ imageUrl: string | null } | null>;
  update(args: { where: { id: string }; data: { imageUrl: string | null } }): Promise<unknown>;
};

/** The delegate that owns the item's `imageUrl`, on the app client or an open transaction. */
export function itemDelegate(client: object, type: PhotoEntityType): ItemDelegate {
  return (client as Record<string, unknown>)[OWNER_DELEGATE[type]] as ItemDelegate;
}

/**
 * Processes the picture, writes the original and the preview, creates the row
 * and, when the item has no main picture, makes this one it. The row write and
 * the `imageUrl` update share one transaction on the app client. Both files
 * are removed when anything after the first write fails.
 */
export async function addPhoto(input: {
  bytes: Buffer;
  type: PhotoEntityType;
  entityId: string;
  label: string | null;
  createdById: string | null;
  viaPass: boolean;
}): Promise<Photo> {
  const processed = await processPicture(input.bytes, { preview: true });
  const id = randomUUID().replace(/-/g, "");
  const fileName = `${id}.${processed.extension}`;
  const files = [{ id, fileName }];

  try {
    await mkdir(path.join(photosDir(), "thumbs"), { recursive: true });
    await writeEncryptedFile(originalPath(fileName), processed.bytes);
    await writeEncryptedFile(previewPath(id), processed.preview as Buffer);

    return await prisma.$transaction(async (tx) => {
      const photo = await tx.photo.create({
        data: {
          id,
          fileName,
          mimeType: processed.mimeType,
          fileSize: processed.bytes.length,
          width: processed.width,
          height: processed.height,
          label: input.label,
          createdById: input.createdById,
          viaPass: input.viaPass,
          [OWNER_COLUMN[input.type]]: input.entityId,
        },
      });
      const item = itemDelegate(tx, input.type);
      const current = await item.findUnique({ where: { id: input.entityId }, select: { imageUrl: true } });
      if (current && !current.imageUrl) {
        await item.update({ where: { id: input.entityId }, data: { imageUrl: photoUrl(fileName) } });
      }
      return photo;
    });
  } catch (e) {
    await removePhotoFiles(files);
    throw e;
  }
}

async function unlinkQuietly(file: string, photoId: string): Promise<void> {
  try {
    await unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(`Could not remove a file of photo ${photoId}; it was left behind:`, describeError(e));
  }
}

/** Removes the original and preview of each photo. Never throws; logs failures. */
export async function removePhotoFiles(photos: Array<{ id: string; fileName: string }>): Promise<void> {
  await Promise.all(
    photos.flatMap((p) => [unlinkQuietly(originalPath(p.fileName), p.id), unlinkQuietly(previewPath(p.id), p.id)]),
  );
}

export async function photoFilesFor(
  where: Prisma.PhotoWhereInput,
): Promise<Array<{ id: string; fileName: string }>> {
  return prisma.photo.findMany({ where, select: { id: true, fileName: true } });
}
