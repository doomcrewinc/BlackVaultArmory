// Client-safe photo constants. `owner.ts` imports the Prisma client and
// `images/process.ts` imports sharp, so neither can be pulled into a client
// component; the values here mirror them and the server stays the authority.

export type PhotoEntityType =
  | "firearm"
  | "accessory"
  | "gear"
  | "kit"
  | "ammo"
  | "supply";

/** Same limit as MAX_PHOTO_BYTES on the server. */
export const MAX_PHOTO_UPLOAD_BYTES = 25 * 1024 * 1024;

export const MAX_PHOTO_LABEL_LENGTH = 80;

/** The query parameter and form field that name an item on the documents API. */
export const DOCUMENT_FIELD = {
  firearm: "firearmId",
  accessory: "accessoryId",
  gear: "gearId",
  kit: "kitId",
  ammo: "ammoStockId",
  supply: "supplyId",
} as const satisfies Record<PhotoEntityType, string>;

/** The noun used in sentences about one item of each type. */
export const ENTITY_NOUN = {
  firearm: "firearm",
  accessory: "accessory",
  gear: "item",
  kit: "kit",
  ammo: "ammunition lot",
  supply: "supply item",
} as const satisfies Record<PhotoEntityType, string>;

/** Fired on `window` when pictures or documents may have arrived from a phone. */
export const ITEM_ATTACHMENTS_CHANGED = "bv:item-attachments-changed";

export type ItemAttachmentsChange = { entityType: PhotoEntityType; entityId: string };

export function announceItemAttachmentsChanged(detail: ItemAttachmentsChange): void {
  window.dispatchEvent(new CustomEvent<ItemAttachmentsChange>(ITEM_ATTACHMENTS_CHANGED, { detail }));
}

/** Returns an error message for a file that cannot be a photo, else null. */
export function photoFileError(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith("image/")) {
    return "That file is not a picture. Choose an image file.";
  }
  if (file.size > MAX_PHOTO_UPLOAD_BYTES) {
    return "File too large. Maximum size is 25MB.";
  }
  return null;
}
