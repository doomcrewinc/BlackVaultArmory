import type { Photo } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const PHOTO_ENTITY_TYPES = ["firearm", "accessory", "gear", "kit", "ammo", "supply"] as const;
export type PhotoEntityType = (typeof PHOTO_ENTITY_TYPES)[number];

export const OWNER_COLUMN = {
  firearm: "firearmId",
  accessory: "accessoryId",
  gear: "gearId",
  kit: "kitId",
  ammo: "ammoStockId",
  supply: "supplyId",
} as const satisfies Record<PhotoEntityType, string>;

export const OWNER_DELEGATE = {
  firearm: "firearm",
  accessory: "accessory",
  gear: "gear",
  kit: "kit",
  ammo: "ammoStock",
  supply: "supply",
} as const satisfies Record<PhotoEntityType, string>;

export const SAFE_ENTITY_ID = /^[a-zA-Z0-9_-]{1,64}$/;

export function isPhotoEntityType(v: unknown): v is PhotoEntityType {
  return typeof v === "string" && (PHOTO_ENTITY_TYPES as readonly string[]).includes(v);
}

/** `{ firearmId: id }` and so on: exactly one key. */
export function ownerWhere(type: PhotoEntityType, id: string): Record<string, string> {
  return { [OWNER_COLUMN[type]]: id };
}

/** The item's display name, or null when it does not exist. */
export async function findOwnerName(type: PhotoEntityType, id: string): Promise<string | null> {
  switch (type) {
    case "ammo": {
      const row = await prisma.ammoStock.findUnique({
        where: { id },
        select: { caliber: true, brand: true },
      });
      return row ? `${row.caliber} ${row.brand}` : null;
    }
    case "firearm":
    case "accessory":
    case "gear":
    case "kit":
    case "supply": {
      const delegate = prisma[OWNER_DELEGATE[type]] as unknown as {
        findUnique(args: { where: { id: string }; select: { name: true } }): Promise<{ name: string } | null>;
      };
      const row = await delegate.findUnique({ where: { id }, select: { name: true } });
      return row ? row.name : null;
    }
  }
}

/** Which entity a Photo row belongs to. Throws unless exactly one owner column is set. */
export function ownerOf(
  photo: Pick<Photo, "firearmId" | "accessoryId" | "gearId" | "kitId" | "ammoStockId" | "supplyId">,
): { type: PhotoEntityType; id: string } {
  const owners = PHOTO_ENTITY_TYPES.flatMap((type) => {
    const id = photo[OWNER_COLUMN[type]];
    return id ? [{ type, id }] : [];
  });
  if (owners.length !== 1) {
    throw new Error(`A photo must have exactly one owner; this one has ${owners.length}`);
  }
  return owners[0];
}
