# Photo Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every item gets a photo gallery, a phone can add photos and paperwork to one item through a short-lived QR "capture pass", and the server removes location metadata from every stored picture.

**Architecture:** A new `Photo` model owned by exactly one of six item types, stored through `src/lib/files/storage.ts` under `<uploadsRoot>/images/photos/`. One image-processing module (`sharp`) used by every picture upload. A new `CapturePass` model holding only a token hash; public routes under `/api/capture/` accept uploads for the pass's item and nothing else.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 5 (SQLite + PostgreSQL), `sharp` 0.34 (already a dependency), `qrcode` (already a dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-photo-ingest-design.md`. Read it before any task. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- Read the repository's `CLAUDE.md` and the "Changing the schema" section of `CONTRIBUTING.md` before touching anything.
- No new dependency. `sharp` and `qrcode` are already in `package.json`.
- Routes do file I/O only through `src/lib/files/storage.ts` (`uploadsRoot`, `writeEncryptedFile`, `readDecryptedFile`). `src/lib/files/no-plaintext-route-io.test.ts` enforces this; removing a file with `fs.unlink` lives in a `src/lib` module, not in a route.
- A schema change lands in both providers in the same commit: edit only `prisma/schema.base.prisma`, `npm run gen:schemas`, one new timestamped migration folder under `prisma/sqlite/migrations` AND one under `prisma/postgres/migrations` (PostgreSQL has incremental migrations beside `0_init`; never rewrite `0_init`), `npm run db:generate`.
- Never touch `prisma/prisma/dev.db`, `scripts/fixtures/`, the `certwarden` container or the `dashboard` host. Wrap every `docker` command in `timeout`. Do not restart OrbStack.
- Stage explicit paths. Never `git add -A` or `git add .`. Conventional commits.
- Comments describe the code as it is: no task numbers, review labels or history.
- No secret or capture-pass token in a log line, an error message or an audit event. Only `hashToken(token)` is stored.
- Exact values, used verbatim: photo size limit `25 * 1024 * 1024` bytes; pixel limit `100_000_000`; JPEG and WebP quality `92`; preview longest side `480` px, WebP quality `80`; pass lifetime `15 * 60_000` ms; pass upload limit `50`; pass upload rate `20` per `60_000` ms; label limit `80` characters; laptop poll interval `3000` ms.
- Entity types, verbatim: `"firearm" | "accessory" | "gear" | "kit" | "ammo" | "supply"`, mapping to `Photo`/`Document` columns `firearmId`, `accessoryId`, `gearId`, `kitId`, `ammoStockId`, `supplyId` and Prisma delegates `firearm`, `accessory`, `gear`, `kit`, `ammoStock`, `supply`.
- Document types that exist today, verbatim: `RECEIPT`, `PHOTO`, `NFA_TAX_STAMP`, `OTHER`.
- The HEIC message, verbatim: `HEIC photos are not supported. On an iPhone, set Camera → Formats to Most Compatible, or send the photo as JPEG.`
- Tests: `npm test`, `npm run typecheck`, `npm run lint` must pass before each commit. A new test file that reads a PostgreSQL URL must be added to `scripts/ci/pg-real-db-files.json`. New type errors are not allowed (`scripts/check-types.sh` baseline).
- UI follows the existing dark theme classes (`text-vault-text`, `bg-vault-surface`, `border-vault-border`, accent `#00C2FF`, error `#E53935`, success `#00C853`) and `lucide-react` icons. No emojis in UI text.

## Review Focus

1. **A photo taken sideways on a phone** (EXIF orientation 6) must be stored upright, since the orientation tag is removed with the rest of the metadata. Test in Task 2.
2. **Two uploads arriving together on a pass with 49 uploads** must store exactly one. Test in Task 5 (real database).
3. **A pass token for item A used with a form field naming item B** must still upload to A only; the public route takes no item from the request. Test in Task 5.
4. **A failed database insert after the file was written** must leave no file behind, and a failed pass upload must give its slot back. Tests in Tasks 3 and 5.
5. **Deleting the photo that is the item's main picture** must clear the item's `imageUrl`, not leave a broken image in lists. Test in Task 3.

---

### Task 1: Schema, migrations and registries

**Files:**
- Modify: `prisma/schema.base.prisma`
- Generated: `prisma/sqlite/schema.prisma`, `prisma/postgres/schema.prisma`
- Create: `prisma/sqlite/migrations/20261004000000_add_photos_and_capture_passes/migration.sql`
- Create: `prisma/postgres/migrations/20261004000000_add_photos_and_capture_passes/migration.sql`
- Modify: `src/lib/backup/models.ts`, `src/lib/audit/registry.ts`, `src/lib/audit/labels.ts`, `src/lib/audit/actions.ts`, `src/lib/audit/query.ts` (action groups)
- Test: `src/lib/backup/models.test.ts`, `src/lib/audit/registry.test.ts`, `src/lib/audit/labels.test.ts` (existing guard tests; extend labels)

**Interfaces:**
- Produces: Prisma models `Photo`, `CapturePass`; `AmmoStock.imageUrl`, `Supply.imageUrl`; `Document.ammoStockId`, `Document.supplyId`, `Document.kitId`; audit actions `CAPTURE_PASS_CREATED`, `CAPTURE_PASS_CLOSED`.

- [ ] **Step 1: Edit `prisma/schema.base.prisma`.** Add:

```prisma
// ─── PHOTOS ───────────────────────────────────────────────────
// A gallery picture. Exactly one owner column is set; src/lib/photos/owner.ts
// is the only code that chooses it. The file is
// <uploadsRoot>/images/photos/<fileName>, its preview
// <uploadsRoot>/images/photos/thumbs/<id>.webp.
model Photo {
  id          String     @id @default(cuid())
  fileName    String     @unique
  mimeType    String
  fileSize    Int
  width       Int
  height      Int
  label       String?
  firearmId   String?
  accessoryId String?
  gearId      String?
  kitId       String?
  ammoStockId String?
  supplyId    String?
  firearm     Firearm?   @relation(fields: [firearmId], references: [id], onDelete: Cascade)
  accessory   Accessory? @relation(fields: [accessoryId], references: [id], onDelete: Cascade)
  gear        Gear?      @relation(fields: [gearId], references: [id], onDelete: Cascade)
  kit         Kit?       @relation(fields: [kitId], references: [id], onDelete: Cascade)
  ammoStock   AmmoStock? @relation(fields: [ammoStockId], references: [id], onDelete: Cascade)
  supply      Supply?    @relation(fields: [supplyId], references: [id], onDelete: Cascade)
  // The account that added it. No relation: accounts are not in backups.
  createdById String?
  viaPass     Boolean    @default(false)
  createdAt   DateTime   @default(now())

  @@index([firearmId])
  @@index([accessoryId])
  @@index([gearId])
  @@index([kitId])
  @@index([ammoStockId])
  @@index([supplyId])
}

// A short-lived, upload-only pass for one item, opened from a signed-in
// session and used by a phone with no session. Only the token's hash is stored.
model CapturePass {
  id          String    @id @default(cuid())
  tokenHash   String    @unique
  entityType  String
  entityId    String
  createdById String
  createdBy   User      @relation("CapturePassIssuer", fields: [createdById], references: [id], onDelete: Cascade)
  sessionId   String
  session     Session   @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  createdAt   DateTime  @default(now())
  expiresAt   DateTime
  closedAt    DateTime?
  uploadCount Int       @default(0)

  @@index([entityType, entityId])
}
```

  Add `photos Photo[]` to `Firearm`, `Accessory`, `Gear`, `Kit`, `AmmoStock`, `Supply`. Add `imageUrl String?` to `AmmoStock` and `Supply`. Add `capturePasses CapturePass[] @relation("CapturePassIssuer")` to `User` and `capturePasses CapturePass[]` to `Session`. To `Document` add `ammoStockId String?`, `supplyId String?`, `kitId String?`, their relations (`onDelete: SetNull`, like the existing three), `@@index` on each, and `documents Document[]` on `AmmoStock`, `Supply`, `Kit`.

- [ ] **Step 2:** `npm run gen:schemas`. Create both migrations following "Changing the schema" in `CONTRIBUTING.md` (SQLite: `--from-migrations` with a temp shadow file; PostgreSQL: `--from-migrations prisma/postgres/migrations` with a scratch shadow database whose name contains `shadow`). Read both SQL files: they must only `CREATE TABLE`/`CREATE INDEX`/add nullable columns (SQLite may rebuild a table to add a foreign key; that is expected for `Document`). If no PostgreSQL server is reachable within a `timeout 60` docker attempt, write the PostgreSQL SQL by hand from the generated schema and say so in the report; the CI drift job is the check.
- [ ] **Step 3:** `npm run db:generate`, then `npm run db:check-drift` (SQLite leg always; PostgreSQL leg when `SHADOW_DATABASE_URL` is set).
- [ ] **Step 4:** Run `npx vitest run src/lib/backup/models.test.ts src/lib/audit/registry.test.ts`. Expected: FAIL naming `Photo` and `CapturePass` as unregistered.
- [ ] **Step 5:** Register them.
  - `src/lib/backup/models.ts`: append `{ model: "Photo", delegate: "photo", key: "photos" }` after `KitItem` (all six owners precede it). Add `"CapturePass"` to `BACKUP_EXCLUDED_MODELS` and extend the comment: a pass is a 15-minute credential tied to a session and is never restorable state.
  - `src/lib/audit/registry.ts`: add `"Photo"` to `AUDITED_MODELS`; add `CapturePass` to `AUDIT_EXCLUDED_MODELS` with the reason `"Creation and closing are recorded as their own audit actions (CAPTURE_PASS_CREATED, CAPTURE_PASS_CLOSED); the row holds only a token hash and a counter."`
  - `src/lib/audit/labels.ts`: `case "Photo"`: return `Photo "<label>"` when `label` is a non-empty string, else `"Photo"`.
  - `src/lib/audit/actions.ts`: append `"CAPTURE_PASS_CREATED"`, `"CAPTURE_PASS_CLOSED"`. In `src/lib/audit/query.ts` add both to the `security` action group (a test there checks every action is in a group or deliberately not; follow it).
- [ ] **Step 6:** Add label tests: `labelFor("Photo", { id: "p1", label: "left side" })` → `Photo "left side"`; `labelFor("Photo", { id: "p1", label: null })` → `Photo`.
- [ ] **Step 7:** `npm test`, `npm run typecheck`, `npm run lint`. All pass. Any test that enumerates backup keys or audit actions and now fails is updated to include the new entries, not loosened.
- [ ] **Step 8: Commit** `feat(photos): Photo and CapturePass models, document owners for ammo, supplies and kits`.

---

### Task 2: Picture processing

**Files:**
- Create: `src/lib/images/process.ts`, `src/lib/images/process.test.ts`
- Modify: `src/app/api/images/upload/route.ts`, `src/app/api/images/upload/route.test.ts`
- Modify: `src/app/api/documents/upload/route.ts`, `src/app/api/documents/route.test.ts` or a new `src/app/api/documents/upload/route.test.ts`

**Interfaces:**
- Produces:

```ts
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTO_PIXELS = 100_000_000;
export const HEIC_MESSAGE =
  "HEIC photos are not supported. On an iPhone, set Camera → Formats to Most Compatible, or send the photo as JPEG.";

export type ProcessedPicture = {
  bytes: Buffer;            // re-saved, no metadata, upright
  extension: "jpg" | "png" | "webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  preview?: Buffer;         // WebP, longest side 480; only when opts.preview
};

export class PictureRejected extends Error {
  constructor(public readonly code: "TOO_LARGE" | "NOT_A_PICTURE" | "HEIC" | "TOO_MANY_PIXELS" | "METADATA_REMAINS", message: string) { super(message); }
}

/** Throws PictureRejected; any other error is a server fault. */
export async function processPicture(input: Buffer, opts?: { preview?: boolean; maxBytes?: number }): Promise<ProcessedPicture>;
```

- [ ] **Step 1: Write failing tests** in `process.test.ts`. Build inputs with `sharp` itself inside the test (no binary fixtures):
  - a 40×20 JPEG written `.withMetadata({ exif: { IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" } } })` → output `sharp(out.bytes).metadata()` has `exif`, `xmp`, `iptc` all `undefined`; `width` 40, `height` 20; `extension` `"jpg"`.
  - the same picture written with `.withMetadata({ orientation: 6 })` → output is 20×40 (rotated upright) and has no `orientation`.
  - a PNG and a WebP each keep their format and dimensions and lose metadata.
  - a JPEG with an ICC profile (`.withIccProfile("srgb")`) → output `metadata().icc` is defined.
  - `{ preview: true }` on a 1200×600 picture → `preview` is WebP, 480×240. On a 100×50 picture the preview is not enlarged (100×50).
  - 12 bytes `00 00 00 18 66 74 79 70 68 65 69 63` (`ftypheic`) → `PictureRejected` code `HEIC`, message `HEIC_MESSAGE`.
  - bytes `[1,2,3,4]` → code `NOT_A_PICTURE`. A PDF header `%PDF-1.4` → `NOT_A_PICTURE`.
  - `maxBytes: 10` with a valid JPEG → code `TOO_LARGE`.
  - a picture over the pixel limit: call with a module-level override — export `processPicture` so the limit is read from an optional `opts.maxPixels` (default `MAX_PHOTO_PIXELS`); a 40×20 picture with `maxPixels: 100` → `TOO_MANY_PIXELS`.
- [ ] **Step 2:** `npx vitest run src/lib/images/process.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement.**

```ts
import sharp from "sharp";
import { detectFileSignature, isHeicFamilySignature } from "@/lib/server/file-signatures";

sharp.concurrency(1);

const FORMATS = {
  jpg: { mimeType: "image/jpeg", save: (p: sharp.Sharp) => p.jpeg({ quality: 92 }) },
  png: { mimeType: "image/png", save: (p: sharp.Sharp) => p.png() },
  webp: { mimeType: "image/webp", save: (p: sharp.Sharp) => p.webp({ quality: 92 }) },
} as const;

export async function processPicture(input, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_PHOTO_BYTES;
  const maxPixels = opts.maxPixels ?? MAX_PHOTO_PIXELS;
  if (input.length > maxBytes) throw new PictureRejected("TOO_LARGE", `File too large. Maximum size is ${Math.round(maxBytes / 1048576)}MB.`);
  if (isHeicFamilySignature(input)) throw new PictureRejected("HEIC", HEIC_MESSAGE);
  const detected = detectFileSignature(input);
  const ext = detected?.extension as keyof typeof FORMATS | undefined;
  if (!ext || !(ext in FORMATS)) throw new PictureRejected("NOT_A_PICTURE", "Invalid file type. Supported formats: JPEG, PNG, WebP.");

  let meta: sharp.Metadata;
  try { meta = await sharp(input, { limitInputPixels: maxPixels }).metadata(); }
  catch { throw new PictureRejected("NOT_A_PICTURE", "This file could not be read as a picture."); }
  if ((meta.width ?? 0) * (meta.height ?? 0) > maxPixels) throw new PictureRejected("TOO_MANY_PIXELS", "This picture is too large (over 100 megapixels).");

  // rotate() with no argument applies the EXIF orientation to the pixels.
  // sharp writes no metadata unless asked; keepIccProfile() keeps only the colour profile.
  const upright = () => sharp(input, { limitInputPixels: maxPixels }).rotate();
  let bytes: Buffer;
  try { bytes = await FORMATS[ext].save(upright().keepIccProfile()).toBuffer(); }
  catch (e) { /* pixel limit trips here for some inputs */ throw mapSharpError(e); }

  const out = await sharp(bytes).metadata();
  if (out.exif || out.xmp || out.iptc || (out.orientation && out.orientation !== 1)) {
    throw new PictureRejected("METADATA_REMAINS", "This picture's hidden data could not be removed, so it was not stored.");
  }
  const preview = opts.preview
    ? await upright().resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true }).webp({ quality: 80 }).toBuffer()
    : undefined;
  return { bytes, extension: ext, mimeType: FORMATS[ext].mimeType, width: out.width!, height: out.height!, preview };
}
```

  `mapSharpError`: an error whose message contains `pixel limit` → `TOO_MANY_PIXELS`; anything else from decoding → `NOT_A_PICTURE`. Check what `detectFileSignature` returns for JPEG (`"jpg"` vs `"jpeg"`) and normalise to `"jpg"`. If `keepIccProfile()` causes an `exif` block to appear in the output for any test input, fix the implementation, not the check.
- [ ] **Step 4:** Tests pass.
- [ ] **Step 5: `POST /api/images/upload`.** Replace the size check, signature check and HEIC branch with `processPicture(buffer)`; on `PictureRejected` return 400 `{ error: e.message }`. Store `processed.bytes` with `processed.extension`; return `size: processed.bytes.length`, `mimeType: processed.mimeType`. Remove `MAX_SIZE` and the "Wave 3" text. Update `route.test.ts`: its fake 12-byte "PNG" is no longer a decodable picture — build a real 4×4 PNG with `sharp` in the test; add: a JPEG with GPS EXIF is written without it (`writeEncryptedFile` mock's buffer argument has no `exif`); a HEIC signature → 400 with `HEIC_MESSAGE`; an 11 MB valid JPEG is accepted (generate noise: `sharp({ create: … , noise })` or pad is not possible for JPEG — instead mock nothing and assert the limit by calling with `file.size` just over 25 MB of random bytes → 400 "File too large. Maximum size is 25MB.").
- [ ] **Step 6: `POST /api/documents/upload`.** After signature detection, when the detected extension is `jpg`, `png` or `webp`: `processPicture(buffer, { maxBytes: MAX_SIZE })` (the 20 MB document limit stays) and store `processed.bytes`, `fileSize: processed.bytes.length`, `mimeType: processed.mimeType`. PDFs unchanged. `PictureRejected` → 400. Tests: an image document with GPS EXIF is stored without it; a PDF's stored bytes equal the uploaded bytes.
- [ ] **Step 7:** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 8: Commit** `feat(images): strip metadata from every stored picture, raise the photo limit to 25 MB`.

---

### Task 3: Photo storage, owner helper and the signed-in photos API

**Files:**
- Create: `src/lib/photos/owner.ts`, `src/lib/photos/owner.test.ts`
- Create: `src/lib/photos/store.ts`, `src/lib/photos/store.test.ts`
- Create: `src/app/api/photos/route.ts`, `src/app/api/photos/[id]/route.ts`, `src/app/api/photos/route.test.ts`, `src/app/api/photos/[id]/route.test.ts`
- Modify: the six item DELETE routes: `src/app/api/firearms/[id]/route.ts`, `accessories/[id]`, `gear/[id]`, `kits/[id]`, `ammo/[id]`, `supplies/[id]`
- Modify: `src/app/api/documents/route.ts`, `src/app/api/documents/upload/route.ts`, `src/app/api/documents/[id]/route.ts` (new owner columns)

**Interfaces:**
- Consumes: `processPicture`, `PictureRejected` (Task 2); Prisma `Photo` (Task 1).
- Produces:

```ts
// src/lib/photos/owner.ts
export const PHOTO_ENTITY_TYPES = ["firearm", "accessory", "gear", "kit", "ammo", "supply"] as const;
export type PhotoEntityType = (typeof PHOTO_ENTITY_TYPES)[number];
export const OWNER_COLUMN: Record<PhotoEntityType, "firearmId" | "accessoryId" | "gearId" | "kitId" | "ammoStockId" | "supplyId">;
export const OWNER_DELEGATE: Record<PhotoEntityType, "firearm" | "accessory" | "gear" | "kit" | "ammoStock" | "supply">;
export function isPhotoEntityType(v: unknown): v is PhotoEntityType;
export const SAFE_ENTITY_ID: RegExp; // /^[a-zA-Z0-9_-]{1,64}$/
/** { firearmId: id } etc. — exactly one key. */
export function ownerWhere(type: PhotoEntityType, id: string): Record<string, string>;
/** The item's display name, or null when it does not exist. AmmoStock: `${caliber} ${brand}`; the rest: `name`. */
export async function findOwnerName(type: PhotoEntityType, id: string): Promise<string | null>;
/** Which entity a Photo row belongs to. Throws if not exactly one owner column is set. */
export function ownerOf(photo: Pick<Photo, "firearmId" | "accessoryId" | "gearId" | "kitId" | "ammoStockId" | "supplyId">): { type: PhotoEntityType; id: string };

// src/lib/photos/store.ts
export function photoUrl(fileName: string): string;          // `/uploads/images/photos/${fileName}`
export function previewUrl(id: string): string;              // `/uploads/images/photos/thumbs/${id}.webp`
export type PhotoDto = { id: string; url: string; previewUrl: string; label: string | null; width: number; height: number; fileSize: number; viaPass: boolean; createdAt: string; isMain: boolean };
export function toPhotoDto(photo: Photo, mainImageUrl: string | null): PhotoDto;
/**
 * Processes, writes both files, creates the row and — when the item has no
 * main picture — sets the item's imageUrl. Removes the files if the database
 * write fails. `tx` runs the row write on an open transaction (the capture
 * route uses it); otherwise the app client is used.
 */
export async function addPhoto(input: { bytes: Buffer; type: PhotoEntityType; entityId: string; label: string | null; createdById: string | null; viaPass: boolean }): Promise<Photo>;
export async function removePhotoFiles(photos: Array<{ id: string; fileName: string }>): Promise<void>; // never throws; logs failures
export async function photoFilesFor(where: Prisma.PhotoWhereInput): Promise<Array<{ id: string; fileName: string }>>;
export function normaliseLabel(raw: unknown): string | null; // trim; "" → null; throws RangeError over 80 chars
```

- [ ] **Step 1: Tests for `owner.ts`** (pure parts): `ownerWhere("ammo","a1")` → `{ ammoStockId: "a1" }`; `ownerOf` with two columns set throws; with none set throws; `isPhotoEntityType("build")` false.
- [ ] **Step 2: Tests for `store.ts`** with `@/lib/prisma` and `@/lib/files/storage` mocked (follow `src/app/api/images/upload/route.test.ts` for the mocking style):
  - `addPhoto` writes `<root>/images/photos/<id>.jpg` and `<root>/images/photos/thumbs/<id>.webp` through `writeEncryptedFile`, where `<id>` is generated before the write (use `createId` pattern: `randomUUID().replace(/-/g, "")`, and pass it as the row's `id`), then creates the row with that id.
  - when `prisma.photo.create` rejects, both files are unlinked and the error is rethrown.
  - when the item's `imageUrl` is null, it is set to the photo's URL in the same transaction; when it is already set, it is left alone.
  - `normaliseLabel("  left side ")` → `"left side"`; `normaliseLabel("")` → `null`; 81 characters → throws.
  - `removePhotoFiles` ignores `ENOENT` and does not throw on other errors.
- [ ] **Step 3: Implement `owner.ts` and `store.ts`.** `addPhoto` order: `processPicture(bytes, { preview: true })` → `fs.mkdir` both folders → write original, write preview → `prisma.$transaction(async (tx) => { create row; read item imageUrl; if null, update })` → on any failure after a write, `removePhotoFiles`. File removal uses `fs.unlink` from `node:fs/promises` here in `src/lib` (not in a route).
- [ ] **Step 4: Routes.**
  - `GET /api/photos?entityType=&entityId=`: `requireAuth`; validate type with `isPhotoEntityType` and id with `SAFE_ENTITY_ID` (400); 404 when `findOwnerName` is null; return `{ photos: PhotoDto[] }` ordered `createdAt asc`, `isMain` computed against the item's `imageUrl`.
  - `POST /api/photos` (multipart `file`, `entityType`, `entityId`, `label?`): `requireAuth`; `enforceRateLimit({ key: \`upload:photos:u:${user.id}\`, windowMs: 60_000, maxAttempts: 20 })` → 429; validation as above; `normaliseLabel` (400 "Label is too long (80 characters at most)."); `file.size > MAX_PHOTO_BYTES` → 400 before reading the body into memory; `addPhoto({ …, createdById: user.id, viaPass: false })`; `PictureRejected` → 400 `{ error: e.message }`; 201 `{ photo: PhotoDto }`. Unknown errors: `console.error("POST /api/photos failed")` with no request data, 500.
  - `PATCH /api/photos/[id]` body `{ label?: string | null, main?: true }`: 404 when missing; label through `normaliseLabel`; `main: true` updates the owner's `imageUrl` to `photoUrl(fileName)` (delegate from `ownerOf`). Returns `{ photo: PhotoDto }`.
  - `DELETE /api/photos/[id]`: in one transaction delete the row and, when the owner's `imageUrl === photoUrl(fileName)`, set it to null; then `removePhotoFiles`. 404 when missing. Returns `{ success: true }`.
- [ ] **Step 5: Route tests** (mock style of the existing route tests): each validation branch; GET marks the main picture; POST 201 shape; PATCH main sets `imageUrl`; **DELETE of the main picture clears `imageUrl`**; DELETE of another photo does not; 401 when `requireAuth` returns a response.
- [ ] **Step 6: Item DELETE routes.** In each of the six, before the delete: `const files = await photoFilesFor(ownerWhere(type, id))`; after the delete succeeds: `await removePhotoFiles(files)`. In `firearms/[id]` with `deleteAccessories`, also collect the photos of the accessories that will be deleted (the route already computes their ids). Add one test per route (or one parameterised test file `src/app/api/photos/item-delete.test.ts`) asserting `removePhotoFiles` is called with the item's files after a successful delete and not called when the delete fails. Keep duplicated test bodies out: SonarCloud fails the PR above 3% duplicated new lines — parameterise with `it.each`.
- [ ] **Step 7: Documents API.** `GET /api/documents` accepts `ammoStockId`, `supplyId`, `kitId` filters and includes `ammoStock: { select: { id, caliber, brand } }`, `supply`/`kit: { select: { id, name } }`. `POST /api/documents` and `POST /api/documents/upload` accept the three new ids. `GET`/`PUT /api/documents/[id]` include and accept them (and `gearId`, which `PUT` drops today). Tests for the new filters and fields.
- [ ] **Step 8:** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 9: Commit** `feat(photos): gallery storage and API, documents on ammo, supplies and kits`.

---

### Task 4: Capture pass library and signed-in routes

**Files:**
- Create: `src/lib/capture/pass.ts`, `src/lib/capture/pass.test.ts`, `src/lib/capture/pass.real-db.test.ts`
- Create: `src/app/api/capture-passes/route.ts`, `src/app/api/capture-passes/[id]/route.ts`, tests beside each
- Modify: `scripts/ci/pg-real-db-files.json` if the real-db test reads a PostgreSQL URL

**Interfaces:**
- Consumes: `generateToken`, `hashToken` (`src/lib/auth/tokens.ts`); `PhotoEntityType`, `findOwnerName` (Task 3); `recordEventBestEffort` (`src/lib/audit/events.ts`).
- Produces:

```ts
export const PASS_TTL_MS = 15 * 60_000;
export const PASS_MAX_UPLOADS = 50;
export type PassEndReason = "expired" | "closed" | "full";
export type OpenPass = { id: string; entityType: PhotoEntityType; entityId: string; createdById: string; creatorName: string; expiresAt: Date; uploadCount: number };

/** Closes any open pass for the item, creates a new one. Returns the raw token once. */
export async function createPass(opts: { entityType: PhotoEntityType; entityId: string; createdById: string; sessionId: string; now?: Date }): Promise<{ id: string; token: string; expiresAt: Date }>;
/** null = no such token. A pass whose session is gone or whose creator is disabled reads as "closed". */
export async function findPass(rawToken: string, now?: Date): Promise<{ ok: true; pass: OpenPass } | { ok: false; reason: PassEndReason } | null>;
/** Atomically takes one upload slot. false when the pass is no longer open or is full. */
export async function takeSlot(passId: string, now?: Date): Promise<boolean>;
/** Gives a slot back after a failed upload. */
export async function returnSlot(passId: string): Promise<void>;
/** Sets closedAt if still open. Returns whether it changed anything. */
export async function closePass(passId: string, now?: Date): Promise<boolean>;
```

  `creatorName` is `"<displayName> (@<username>)"`, the audit actor-name format (`src/lib/audit/actor.ts`).

- [ ] **Step 1: Unit tests** (`pass.test.ts`, prisma mocked): `findPass` → null for an unknown hash; `expired` when `expiresAt <= now`; `closed` when `closedAt` set; `full` when `uploadCount >= 50`; `closed` when `createdBy.disabledAt` is set; `ok` otherwise. Precedence when several apply: `closed`, then `expired`, then `full`. `createPass` stores `hashToken(token)`, never the token; `expiresAt = now + PASS_TTL_MS`.
- [ ] **Step 2: Real-database test** (`pass.real-db.test.ts`; copy the database setup of `src/lib/auth/redeem.real-db.test.ts`, SQLite always and PostgreSQL when its URL env is set): `createPass` twice for one item leaves the first closed; `takeSlot` at `uploadCount: 49` called twice concurrently (`Promise.all`) → exactly one `true`, final count 50; `takeSlot` on a closed or expired pass → `false`; `returnSlot` decrements and never goes below 0; deleting the `Session` row deletes the pass (`findPass` → null).
- [ ] **Step 3: Implement.** `takeSlot` is one statement:

```ts
const { count } = await prisma.capturePass.updateMany({
  where: { id: passId, closedAt: null, expiresAt: { gt: now }, uploadCount: { lt: PASS_MAX_UPLOADS } },
  data: { uploadCount: { increment: 1 } },
});
return count === 1;
```

  `returnSlot`: `updateMany({ where: { id, uploadCount: { gt: 0 } }, data: { uploadCount: { decrement: 1 } } })`. `createPass`: one transaction — `updateMany` closing open passes for `(entityType, entityId)`, then `create`.
- [ ] **Step 4: Routes.**
  - `POST /api/capture-passes` body `{ entityType, entityId }`: `getCurrentUser()` (401); validate (400); item must exist (404); `enforceRateLimit({ key: \`capture-pass:u:${user.id}\`, windowMs: 60_000, maxAttempts: 10 })` → 429; `createPass({ …, createdById: user.id, sessionId: user.sessionId })`; `recordEventBestEffort(null, { action: "CAPTURE_PASS_CREATED", entityType: <Prisma model name of the item>, entityId, entityLabel: <item name>, changes: { passId, expiresAt } })`; 201 `{ id, token, path: \`/capture/${token}\`, expiresAt }` with `Cache-Control: no-store`. The token is never logged or audited.
  - `GET /api/capture-passes/[id]`: only the creating account (404 for anyone else, admins included). Returns `{ status: "open" | PassEndReason, expiresAt, uploadCount, remaining, photos: PhotoDto[], documents: Array<{ id, name, type, createdAt }> }` where photos are the item's `viaPass` photos with `createdAt >= pass.createdAt` and documents are the item's documents with `createdAt >= pass.createdAt`.
  - `DELETE /api/capture-passes/[id]`: the creating account or an admin (403 otherwise, 404 when missing); `closePass`; when it changed something, `recordEventBestEffort(null, { action: "CAPTURE_PASS_CLOSED", … })`; `{ success: true }`.
- [ ] **Step 5: Route tests:** 401; validation; 404 item; the response token hashes to the stored hash; another user's GET → 404; DELETE by another non-admin → 403, by an admin → 200; audit calls made with no token in `changes`.
- [ ] **Step 6:** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 7: Commit** `feat(capture): capture passes for one item, created and closed from a session`.

---

### Task 5: Public capture routes

**Files:**
- Modify: `src/lib/server/auth-gate.ts`, `src/lib/server/auth-gate.test.ts`
- Create: `src/lib/capture/throttle.ts` (`export const captureThrottle = createThrottle();`)
- Create: `src/app/api/capture/[token]/route.ts`, `src/app/api/capture/[token]/upload/route.ts`, tests beside each
- Create: `src/lib/capture/upload.ts`, `src/lib/capture/upload.real-db.test.ts`

**Interfaces:**
- Consumes: `findPass`, `takeSlot`, `returnSlot` (Task 4); `addPhoto` (Task 3); `processPicture` (Task 2); `auditStorage` (`src/lib/audit/context.ts`); `getClientIp` (`src/lib/server/client-ip.ts`); `documentsRoot`, `writeEncryptedFile`.
- Produces: `GET /api/capture/[token]` → `{ itemName, entityType, expiresAt, remaining }`; `POST /api/capture/[token]/upload` → 201 `{ kind: "photo" | "paperwork", id, remaining }`.

- [ ] **Step 1: Auth gate.** Add `"/capture/"` and `"/api/capture/"` to `PUBLIC_PREFIXES`. Tests: `isPublicPath("/capture/abc")` and `isPublicPath("/api/capture/abc/upload")` are true; `isPublicPath("/api/capture-passes")` and `isPublicPath("/api/capture-passes/x")` are **false** (the prefix ends in `/`, so `capture-passes` must not match; this test pins it). Check `src/proxy.ts` and `src/lib/server/request-gate.ts` for any second list of public paths or an origin check on POST and make the phone's same-origin POST pass; add a test for whatever you change.
- [ ] **Step 2: Shared resolution.** In `src/lib/capture/upload.ts`:

```ts
/** Throttles wrong tokens by client address, then resolves the pass. */
export async function resolvePass(request: Request, rawToken: string):
  Promise<{ ok: true; pass: OpenPass } | { ok: false; status: 404 | 410 | 429; body: { error: string; reason?: PassEndReason }; retryAfter?: number }>;
```

  Key `ip:${getClientIp(request) ?? "unknown"}`. `captureThrottle.check` blocked → 429 with `Retry-After`. Token not matching `/^[A-Za-z0-9_-]{20,100}$/` or `findPass` null → `captureThrottle.fail(key)`, 404 `{ error: "This link is not valid." }`. Ended → 410 `{ error, reason }` with messages: expired `"This pass has expired. Make a new one on the computer."`, closed `"This pass was closed. Make a new one on the computer."`, full `"This pass has reached its limit of 50 uploads. Make a new one on the computer."`. Ended passes do not count as throttle failures.
- [ ] **Step 3: `GET /api/capture/[token]`.** `resolvePass`; `findOwnerName` (410 `closed` if the item is gone); return exactly `{ itemName, entityType, expiresAt, remaining: 50 - uploadCount }` with `Cache-Control: no-store`. Test: the JSON has exactly those four keys.
- [ ] **Step 4: `POST /api/capture/[token]/upload`** (multipart `file`, `kind`, `label?`, `docType?`, `name?`). Order:
  1. `resolvePass`.
  2. `enforceRateLimit({ key: \`capture-upload:${pass.id}\`, windowMs: 60_000, maxAttempts: 20 })` → 429.
  3. Validate `kind` ∈ `photo|paperwork`; `file` present; `file.size <= MAX_PHOTO_BYTES` for a photo, `<= 20 MB` for paperwork; for paperwork `docType` ∈ `RECEIPT|PHOTO|NFA_TAX_STAMP|OTHER` (default `RECEIPT`); `label` via `normaliseLabel`; `name` trimmed, at most 120 characters. Any failure → 400, no slot taken.
  4. `takeSlot(pass.id)`; false → re-run `findPass` and answer 410 with its reason (`full` if it still reads open).
  5. Do the work inside `auditStorage.run({ actor: { kind: "user", actorId: pass.createdById, actorName: pass.creatorName, actorIp: getClientIp(request) } }, async () => await …)` so row-audit events are recorded under the pass's creator (the audited client's `$transaction` uses a store's actor when one is present — `src/lib/audit/extension.ts`).
     - photo: `addPhoto({ bytes, type: pass.entityType, entityId: pass.entityId, label, createdById: pass.createdById, viaPass: true })`.
     - paperwork: `processPicture(bytes, { maxBytes: 20 MB })` (camera output is always a picture; a PDF here is rejected with 400 "Paperwork from the phone must be a picture."), write to `documentsRoot()` exactly as `POST /api/documents/upload` does, create the `Document` with the owner column from `OWNER_COLUMN[pass.entityType]`, `notes: "Added from a phone capture pass"`, `name` or `"<Type label> <YYYY-MM-DD>"` (labels: Receipt, Photo, NFA Tax Stamp, Other; date in UTC). Move the shared write-and-create into a function in `src/lib` that both document routes call, rather than copying it.
  6. Any failure after step 4 → `returnSlot(pass.id)`; `PictureRejected` → 400 `{ error: e.message }`; otherwise 500 with a log line that contains no token.
  7. 201 `{ kind, id, remaining }`.
  The route reads no item identifier from the form: `entityType`/`entityId` fields, if sent, are ignored.
- [ ] **Step 5: Tests.** Route tests (mocked): each status above; **a form carrying `entityId` of another item still calls `addPhoto` with the pass's item**; a rejected picture returns the slot; a failed `addPhoto` returns the slot; no GET/DELETE/PATCH export exists on either public route file (`expect(Object.keys(await import("./route"))).toEqual(["POST"])` for upload, `["GET"]` for the info route); five wrong tokens from one address, then a sixth → 429. Real-database test (`upload.real-db.test.ts`): **two concurrent uploads on a pass at 49 → one 201 and one 410 `full`, one Photo row**; an upload through a pass writes an `AuditEvent` with `action: "CREATE"`, `entityType: "Photo"`, `actorId` = the pass's creator; a paperwork upload on an `ammo` pass creates a `Document` with `ammoStockId` set.
- [ ] **Step 6:** `npm test`, `npm run typecheck`, `npm run lint`.
- [ ] **Step 7: Commit** `feat(capture): upload-only public routes for a capture pass`.

---

### Task 6: Gallery and paperwork on the item pages

**Files:**
- Create: `src/components/photos/PhotoGallery.tsx`, `src/components/photos/PhotoGallery.test.tsx`
- Modify: `src/components/shared/ItemDocumentPanel.tsx`, `src/components/shared/DocumentUploader.tsx`
- Modify: the six detail pages: `src/app/vault/[id]/page.tsx`, `src/app/accessories/[id]/page.tsx`, `src/app/gear/item/[id]/page.tsx`, `src/app/kits/[id]/page.tsx`, `src/app/ammo/[id]/page.tsx`, `src/app/supplies/item/[id]/page.tsx`
- Modify: the ammunition and supply list rows/cards so they show `imageUrl` when set (find where the firearm/gear cards render `imageUrl` with `SafeImage` and follow that; `src/components/sections/` and `src/app/ammo/page.tsx`, `src/app/prep/[slug]/page.tsx`)

**Interfaces:**
- Consumes: `/api/photos` routes and `PhotoDto` (Task 3).
- Produces: `<PhotoGallery entityType entityId onContinueOnPhone? />` — a client component; `onContinueOnPhone` is the hook Task 7 uses (when undefined the "Continue on phone" button is not rendered).

- [ ] **Step 1: Component tests** (`@testing-library/react`, `fetch` mocked; follow `src/components/admin/InviteDialog.test.tsx`): renders previews with labels from `GET /api/photos`; empty state text `No photos yet.`; choosing a file POSTs multipart with `entityType`, `entityId`, `file` and adds the returned photo; a 400 shows the server's `error`; "Make main picture" sends `PATCH { main: true }` and marks that photo `Main`; "Delete" asks for confirmation (use `ConfirmDialog` from `src/components/shared`), then sends DELETE and removes it; the file input has `accept="image/*"` and `capture="environment"`.
- [ ] **Step 2: Implement `PhotoGallery`.** A card matching `ItemDocumentPanel`'s frame (title `Photos`, count). Grid of previews (`previewUrl`, `loading="lazy"`, plain `<img>` as the rest of the app does for uploads); clicking opens the full picture in a simple overlay (`url`), closed by Escape or a click outside. Per photo: label (click "Edit label" → inline input, 80 characters max, Enter saves via PATCH), `Main` badge, "Make main picture", "Delete". Header buttons: "Add photo" (hidden file input, label optional — after choosing a file show a small inline form: preview name, label input, "Upload"/"Cancel"), and "Continue on phone" when `onContinueOnPhone` is given. Upload state: disabled button with spinner; errors in the red feedback box style of `ItemDocumentPanel`.
- [ ] **Step 3: Paperwork for all six types.** Widen `ItemDocumentPanel`'s and `DocumentUploader`'s `entityType` to the six photo entity types; map to the query/form field with one lookup object (`firearmId`, `accessoryId`, `gearId`, `kitId`, `ammoStockId`, `supplyId`) replacing the nested ternaries; empty-state text uses one sentence with the item noun. `DocumentUploader`'s file input gains `capture="environment"` only on a second "Take a picture" button (`accept="image/*"`); the existing picker keeps accepting PDF.
- [ ] **Step 4: Mount on the six detail pages.** `<PhotoGallery>` above the documents panel; add `<ItemDocumentPanel>` to the kit, ammo and supply pages (remove the comment on the ammo page that says there is no panel because `Document` has no ammo column). Pages that are server components import the client components directly.
- [ ] **Step 5: Lists.** Ammunition and supply rows/cards show the main picture where `imageUrl` is set, using the same component and size the gear cards use; no layout change when it is null. Make sure the ammo and supply API list/detail responses include `imageUrl` (Prisma returns it by default unless a `select` narrows it).
- [ ] **Step 6:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- [ ] **Step 7: Commit** `feat(photos): gallery and paperwork on every item page`.

---

### Task 7: Capture pass dialog and the phone page

**Files:**
- Create: `src/components/photos/CapturePassDialog.tsx`, `src/components/photos/CapturePassDialog.test.tsx`
- Create: `src/lib/capture/pass-url.ts`, `src/lib/capture/pass-url.test.ts`
- Create: `src/app/capture/[token]/page.tsx`, `src/components/photos/CaptureScreen.tsx`, `src/components/photos/CaptureScreen.test.tsx`
- Modify: `src/components/photos/PhotoGallery.tsx` (own the dialog: a `withPhonePass` boolean prop, default true, replaces the callback if simpler), `next.config.ts` or the page for headers

**Interfaces:**
- Consumes: `/api/capture-passes` (Task 4), `/api/capture/[token]` (Task 5), `/api/network/local-access` (existing; returns `{ url: string | null, … }`).
- Produces:

```ts
// src/lib/capture/pass-url.ts
/** The address a phone should open. `origin` is window.location.origin; `lanUrl` is /api/network/local-access's `url`. */
export function passUrl(origin: string, path: string, lanUrl: string | null): { url: string; reachable: boolean };
```

  `reachable` is false only when the origin's hostname is `localhost`, `127.0.0.1` or `[::1]` and `lanUrl` is null; then `url` is `origin + path` and the dialog shows `Your phone cannot reach "localhost". Open BlackVault on this computer by its network address, then try again.`

- [ ] **Step 1: `pass-url` tests:** `("http://192.168.1.5:3000", "/capture/t", null)` → that origin, reachable; `("http://localhost:3000", "/capture/t", "http://192.168.1.5:3000")` → the LAN URL; `("http://127.0.0.1:3000", …, null)` → not reachable; `("https://vault.example.com", …, "http://192.168.1.5:3000")` → the https origin (never swapped for the LAN URL).
- [ ] **Step 2: `CapturePassDialog`** (frame, QR and copy button modelled on `src/components/admin/InviteDialog.tsx`). On open: POST `/api/capture-passes`; fetch `/api/network/local-access` only when the origin is a loopback host; build the URL with `passUrl`; render QR (`qrcode`, width 200), the link text, Copy, a countdown `mm:ss` to `expiresAt`, a list of what has arrived (photo previews, document names) refreshed by `GET /api/capture-passes/[id]` every `3000` ms while the status is `open`, and "Close pass" (DELETE). When the status is no longer `open`, stop polling and show `Pass ended.` with "New pass". Closing the dialog with X stops polling and leaves the pass open; text under the buttons: `The pass stays open until it expires or you close it.` On unmount clear the interval. When the dialog closes, the gallery reloads its photos.
  Tests: POST on open; QR generated from the built URL; polling adds an arrived photo; "Close pass" sends DELETE; loopback with no LAN URL shows the message and no QR.
- [ ] **Step 3: Phone page.** `src/app/capture/[token]/page.tsx` is a server component: `export const dynamic = "force-dynamic"`; it renders `<CaptureScreen token={token} />` only (no sidebar or app chrome — check how `src/app/invite/[token]/page.tsx` avoids the app layout and do the same). Send `Referrer-Policy: no-referrer` and `Cache-Control: no-store` for `/capture/:path*` through `headers()` in `next.config.ts`, and add a test beside the existing `next.config.test.ts` assertions.
- [ ] **Step 4: `CaptureScreen`** (client). On mount GET `/api/capture/${token}`: 404 → `This link is not valid.`; 410 → the server's message; 429 → `Too many attempts. Wait a moment and try again.` Otherwise: the item's name as the heading, `N uploads left`, two large full-width buttons `Photo` and `Paperwork` (min height 64 px, usable one-handed at 390 px width). Each opens `<input type="file" accept="image/*" capture="environment">`. After a file is chosen: Photo shows an optional `Label` input and `Send`; Paperwork shows a `Type` select (Receipt, NFA Tax Stamp, Photo, Other; default Receipt) and `Send`. Sending POSTs multipart to `/api/capture/${token}/upload`. Below, a list of this visit's uploads: `Sent` (green) or `Failed — Retry` (red, with the server's message; Retry re-sends the same file and fields). A 410 during the visit replaces the buttons with the message. No links to the rest of the app.
  Tests: info load states; photo flow posts `kind=photo` and `label`; paperwork flow posts `kind=paperwork` and `docType`; failure then retry re-posts; 410 on upload hides the buttons.
- [ ] **Step 5:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- [ ] **Step 6: Commit** `feat(capture): "Continue on phone" dialog and the phone capture page`.

---

### Task 8: Backups, exports, the image, and documentation

**Files:**
- Modify: `src/lib/backup/full-backup.real-db.test.ts`, `src/lib/backup/full-restore.real-db.test.ts` (or new cases beside them), `src/lib/files/reencrypt.real-fs.test.ts`
- Modify: `src/app/api/exports/data/route.ts` and its test
- Modify: `scripts/ci/full-backup-linux.sh` or `scripts/ci/encryption-key-linux.sh` (one added check), `README.md`, `CONTRIBUTING.md`, `CLAUDE.md` (only if a rule changed)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Backup round trip.** In the full-backup and full-restore real-database tests add an item of each of two types (a firearm and an ammo stock) with a `Photo` row and its two files under `images/photos/` and `images/photos/thumbs/`, plus a `Document` on the ammo stock. Assert: the archive lists both files; after restore into an empty database and uploads folder the rows exist with the same ids and owner columns and both files decrypt to the original bytes; a `CapturePass` row present at backup time is not in the archive and a pass present before restore is still there after it. Assert an archive made **without** a `photos` key (an older backup) restores (the key is not in `REQUIRED_BACKUP_KEYS`).
- [ ] **Step 2: JSON-only restore.** Find how restore treats `Document` rows whose files are absent (`src/lib/backup/restore-core.ts`, `src/lib/files/startup.ts`) and make `Photo` rows follow the same rule (reported the same way, not a startup failure). Add the test that pins it.
- [ ] **Step 3: Key rotation.** In `reencrypt.real-fs.test.ts` add a file under `images/photos/thumbs/` and assert it is re-encrypted (it is nested one level deeper than existing cases).
- [ ] **Step 4: Data export.** `GET /api/exports/data` JSON gains `photos` (rows: `id`, owner columns, `label`, `width`, `height`, `fileSize`, `mimeType`, `viaPass`, `createdAt`; no `fileName`). Follow the existing `flags.documents` pattern with a `photos` flag defaulting to true; CSV/other formats in that route get a `Photos` section only if sections are generic there. Test.
- [ ] **Step 5: `sharp` in the image.** Add to the Linux Docker CI script a step that runs inside the built app container: `timeout 120 docker compose exec -T blackvault node -e "require('sharp')({create:{width:8,height:8,channels:3,background:'#fff'}}).jpeg().toBuffer().then(b=>{if(b.length<100)process.exit(1);console.log('sharp ok')})"` and fails the script on a non-zero exit (match the script's existing service name and exec style). If `sharp` fails to load in the image, fix the `Dockerfile` (the standalone output must include `node_modules/sharp` and `@img/*`; check `outputFileTracingIncludes` in `next.config.ts`) — this is the one place a Dockerfile change is in scope.
- [ ] **Step 6: Docs.** `README.md`: a "Photos" section — galleries, "Continue on phone" (what a pass can and cannot do, 15 minutes, 50 uploads, anyone who scans it can upload to that item), location data is removed from new uploads, pictures stored before this version are not changed, HEIC is not supported, the 25 MB limit; reverse-proxy note that the body limit already documented (64 MiB) covers it. `CONTRIBUTING.md`: `src/lib/images/process.ts` is the only place pictures are processed; `src/lib/photos/owner.ts` is the only place a photo's owner column is chosen.
- [ ] **Step 7:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`. If Docker is reachable (`timeout 20 docker ps`), run the CI script locally; otherwise say so in the report and rely on CI.
- [ ] **Step 8: Commit** `feat(photos): galleries in backups and exports, sharp checked in the image, docs`.

---

## After the last task

Push the branch, open a PR against `develop` with `gh pr create --repo doomcrewinc/BlackVaultArmory --base develop`, wait for every check including `SonarCloud Code Analysis` on the head commit (poll `https://sonarcloud.io/api/project_pull_requests/list?project=doomcrewinc_BlackVaultArmory`), and fix what they report. The PR body lists breaking changes (spec, "Breaking changes"), the manual phone checklist (spec, "Testing"), and known issues. Never merge.
