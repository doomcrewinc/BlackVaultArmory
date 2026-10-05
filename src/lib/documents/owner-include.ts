const NAME = { select: { id: true, name: true } } as const;

/** The item relations every document response carries. */
export const DOCUMENT_OWNER_INCLUDE = {
  firearm: NAME,
  accessory: NAME,
  gear: NAME,
  ammoStock: { select: { id: true, caliber: true, brand: true } },
  supply: NAME,
  kit: NAME,
} as const;
