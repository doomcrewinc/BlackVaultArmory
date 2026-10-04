# Photo ingest — design

- **Status:** approved in conversation on 2026-10-04; this written spec is awaiting review.
- **Builds on:** accounts and sessions, the audit log, encrypted files at rest (`src/lib/files/storage.ts`), full backups.
- **Base:** `develop` at `d706250`.

## Goal

A person can photograph an item with their phone and have the picture land on that item, without cables, cloud services or typing a URL.

The pictures are for visual identification: the whole firearm, its packaging, a box of ammunition so the same kind can be bought again, a bottle of CLP so it can be found in the store. Receipts and Form 4s are paperwork and go to the existing documents feature, from the same phone screen.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Every item has a gallery: several photos, each with an optional label. One picture is the item's main picture, shown in lists. | user |
| D2 | Firearms, accessories, gear, kits, ammunition and supplies all get galleries. | user |
| D3 | Receipts and Form 4s stay documents. Documents become available on ammunition and supplies. | user |
| D4 | Two ways in: a camera button on the item page, and a QR code on the laptop that the phone scans. | user |
| D5 | The QR code is a capture pass: one item, 15 minutes, upload-only, no sign-in on the phone. Anyone who scans it inside the window can upload to that item. | user |
| D6 | The phone screen asks "Photo" or "Paperwork" for each shot. One pass covers both. | user |
| D7 | The server removes location and other hidden metadata from every picture and keeps full resolution. | user |
| D8 | Photo size limit 25 MB. The server also stores a small preview of each gallery photo. Deleting an item deletes its gallery. | user (part 1) |
| D9 | Any signed-in account can create a pass. 50 uploads per pass. A new pass for an item ends the old one. | user (part 2) |
| D10 | Nothing existing is moved or converted. Galleries start empty. | user (part 3) |
| D11 | Documents also become available on kits, so that a pass for any item type offers both buttons. | this spec; not asked |
| D12 | HEIC and HEIF pictures are rejected with a message, as they are today. | this spec; see "HEIC" |
| D13 | A pass is tied to the session that created it. Signing out on the laptop ends the pass. | this spec; narrows "signs out everywhere" from part 2 |

## Current state

- `Firearm`, `Accessory`, `Gear` and `Kit` each have one `imageUrl` column (`prisma/schema.base.prisma`). `AmmoStock` and `Supply` have none.
- `POST /api/images/upload` stores one picture per item under `<uploadsRoot>/images/<type>s/`, limit 10 MB, and rejects HEIC. `/uploads/[...path]` serves images to signed-in users.
- `Document` attaches to a firearm, accessory or gear item, with `onDelete: SetNull`. `POST /api/documents/upload` accepts pdf, jpg, png and webp up to 20 MB.
- No upload route removes metadata. A phone photo keeps its GPS position on disk and in every backup.
- No file input has a `capture` attribute, so no page opens the phone camera directly.
- `sharp` 0.34 is a dependency and is listed in `serverExternalPackages`. No code in `src` imports it yet.
- Invite links (`AuthToken`, `src/lib/auth/tokens.ts`) store only a hash of the token. `InviteDialog` shows a link and a QR code made with `qrcode`.
- `next.config.ts` sets `proxyClientMaxBodySize: "64mb"`, so a 25 MB upload passes the proxy.
- The full backup and the key-rotation tool walk everything under `<uploadsRoot>/images` and `<uploadsRoot>/documents` (`src/lib/files/upload-walk.ts`).

## Design

### 1. Data model

One schema change, in both providers, in one PR.

**New model `Photo`**

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `fileName` | String | `<id>.<ext>`; the file is `<uploadsRoot>/images/photos/<fileName>` |
| `mimeType` | String | `image/jpeg`, `image/png` or `image/webp` |
| `fileSize` | Int | bytes of the stored picture, before encryption |
| `width`, `height` | Int | pixels, after rotation is applied |
| `label` | String? | at most 80 characters |
| `firearmId`, `accessoryId`, `gearId`, `kitId`, `ammoStockId`, `supplyId` | String? | exactly one is set; each a relation with `onDelete: Cascade`; each indexed |
| `createdById` | String? | the account that added it; a plain column with no relation, because accounts are not in backups |
| `viaPass` | Boolean | true when it arrived through a capture pass |
| `createdAt` | DateTime | |

"Exactly one owner" is enforced in one place, `src/lib/photos/owner.ts`, which every route uses to turn `(entityType, entityId)` into the owner column and to check the item exists.

**New model `CapturePass`**

| Field | Type | Notes |
|---|---|---|
| `id` | cuid | |
| `tokenHash` | String, unique | `hashToken()` from `src/lib/auth/tokens.ts`; the token itself is never stored |
| `entityType`, `entityId` | String | the one item the pass is for |
| `createdById` | String | relation to `User`, `onDelete: Cascade` |
| `sessionId` | String | relation to `Session`, `onDelete: Cascade` |
| `createdAt`, `expiresAt` | DateTime | `expiresAt` = `createdAt` + 15 minutes |
| `closedAt` | DateTime? | |
| `uploadCount` | Int, default 0 | |

**Changed models**

- `AmmoStock` and `Supply` gain `imageUrl String?`.
- `Document` gains `ammoStockId`, `supplyId` and `kitId`, each optional, indexed, `onDelete: SetNull` like the existing three.

All changes are additive. No existing row is rewritten.

### 2. Picture processing

One module, `src/lib/images/process.ts`, used by every route that stores a picture:

1. Check the size limit (25 MB) and the file signature (`detectFileSignature`). Accept JPEG, PNG and WebP.
2. Decode with `sharp`. Reject a picture of more than 100 megapixels.
3. Apply the orientation tag to the pixels, then re-save in the same format at the same pixel dimensions: JPEG at quality 92, PNG lossless, WebP at quality 92. The colour profile is kept. Every other metadata block (EXIF, GPS, XMP, IPTC, maker notes, embedded thumbnail) is dropped.
4. Read the result back and check it has no EXIF, XMP or IPTC block. If it has, reject the upload. Nothing is stored.
5. For gallery photos, also produce a preview: longest side 480 pixels, WebP at quality 80.

"Keeps full resolution" means the same pixel dimensions. A JPEG or WebP is re-saved, so the stored file is not byte-identical to what the camera wrote.

`sharp` runs with a concurrency of 1 so one large upload cannot take all the container's memory.

Routes that use it:

- the new gallery upload routes (sections 3 and 4);
- `POST /api/images/upload`, whose limit rises from 10 MB to 25 MB;
- `POST /api/documents/upload`, for jpg, png and webp. PDFs are stored as they are. The 20 MB document limit does not change.

Pictures already on disk are not reprocessed.

**HEIC.** The `sharp` binaries published on npm cannot decode HEIC (about 85% sure; to be confirmed by the implementation's first test). HEIC stays rejected, with the message "HEIC photos are not supported. On an iPhone, set Camera → Formats to Most Compatible, or send the photo as JPEG." A phone browser normally sends JPEG to a web form already.

### 3. Storage and serving

- Original: `<uploadsRoot>/images/photos/<id>.<ext>`. Preview: `<uploadsRoot>/images/photos/thumbs/<id>.webp`. Both are written with `writeEncryptedFile`.
- Both are under `images`, so the full backup, the restore and the key-rotation tool cover them with no change to `upload-walk.ts`.
- Served by the existing `/uploads/[...path]` route: `/uploads/images/photos/<id>.<ext>` and `/uploads/images/photos/thumbs/<id>.webp`. Signed-in users only.
- The file is written before the row is created. If creating the row fails, the files are removed. A row never points at a missing file because of a failed upload.
- Deleting a photo removes its row, then its two files. Deleting an item removes the files of its photos after the item is deleted. A file that cannot be removed is logged and left; no row refers to it.

### 4. Routes

**Signed in**

| Route | Does |
|---|---|
| `GET /api/photos?entityType=&entityId=` | Lists an item's photos, oldest first. |
| `POST /api/photos` | Multipart: `file`, `entityType`, `entityId`, `label?`. Processes, stores, creates the row. If the item has no main picture, the new photo becomes it. |
| `PATCH /api/photos/[id]` | Body `{ label? , main? }`. `main: true` sets the item's `imageUrl` to this photo. |
| `DELETE /api/photos/[id]` | Removes the photo. If it was the main picture, the item's `imageUrl` becomes null. |
| `POST /api/capture-passes` | Body `{ entityType, entityId }`. Closes any open pass for that item, creates a new one, returns the token once, with `expiresAt`. |
| `GET /api/capture-passes/[id]` | For the laptop: open or ended, time left, and what has arrived (photo previews, document names). Only the creating account can read it. |
| `DELETE /api/capture-passes/[id]` | Sets `closedAt`. Only the creating account or an admin. |

**No session (the phone)**

`/capture/` and `/api/capture/` are added to the public paths in `src/lib/server/auth-gate.ts`.

| Route | Does |
|---|---|
| `GET /capture/[token]` | The phone page. Sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. |
| `GET /api/capture/[token]` | Returns the item's display name and type, `expiresAt`, and uploads remaining. Nothing else about the item. |
| `POST /api/capture/[token]/upload` | Multipart: `file`, `kind` (`photo` or `paperwork`), `label?` for a photo, `docType` and `name?` for paperwork. |

A pass is valid when all of these hold: the hash matches, `closedAt` is null, `expiresAt` is in the future, `uploadCount` is below 50, the creating session still exists, and the creating account is not disabled. Otherwise the answer is 410 with one of `expired`, `closed` or `full`; an unknown token gets 404.

The upload count is taken with one conditional update (`uploadCount < 50` and the pass still open) before the file is processed, and given back if processing or storing fails. Two uploads at once cannot pass the limit.

Paperwork through a pass creates a `Document` owned by the pass's item. `docType` must be one of the existing document types. When `name` is empty, the name is the type's label plus the date.

**Limits on the public routes**

- Wrong tokens: throttled by client address with `createThrottle` (`src/lib/auth/throttle.ts`), like sign-in.
- Uploads: at most 20 a minute for each pass, with `enforceRateLimit`.

### 5. Screens

**Item page (all six item types).** A "Photos" section: a grid of previews, each with its label. Tapping a preview opens the full picture. Each photo has "Make main picture", "Edit label" and "Delete" (with a confirmation). Buttons: "Add photo", "Add paperwork", "Continue on phone". Where an item type has no detail page, the section sits in its edit view.

"Add photo" and "Add paperwork" use `<input type="file" accept="image/*" capture="environment">`. On a phone this opens the camera; on a laptop it opens the file picker. "Add paperwork" on a laptop also accepts PDF.

**Capture pass dialog (laptop).** Modelled on `InviteDialog`: the QR code, the link as text with a copy button, a countdown, the uploads as they arrive (the dialog asks the server every 3 seconds), and "Close pass". Closing the dialog does not close the pass; the button does.

The link's address is the address the laptop's browser is using. When that is `localhost`, `127.0.0.1` or `::1`, the dialog uses the detected network address (`src/lib/network/get-local-ip.ts`), as the Settings page's phone QR code does.

**Phone page (`/capture/[token]`).** The item's name, two large buttons ("Photo", "Paperwork"), and a list of what was sent in this visit with "sent" or "failed — retry" on each. Photo: take the picture, optional label, send. Paperwork: take the picture, choose the type, send. An ended pass shows why and says to make a new one on the laptop. The page shows nothing else from the app and has no navigation.

**Lists.** Ammunition and supply rows show the main picture where the other item types already do.

### 6. Audit

- `Photo` rows are audited like other inventory rows (create, update, delete), with a label in `src/lib/audit/labels.ts`.
- Two new actions: `CAPTURE_PASS_CREATED` and `CAPTURE_PASS_CLOSED`, each naming the item. `CapturePass` rows themselves are not row-audited.
- A photo or document that arrives through a pass is recorded under the account that created the pass, with the pass noted in the event's details.
- Changing the main picture is the existing update of the item's `imageUrl`.

### 7. Backups and exports

- `Photo` joins the backup model list (`src/lib/backup/models.ts`), after all six owner models. `CapturePass` joins `BACKUP_EXCLUDED_MODELS`.
- A backup without photos restores as before. A backup made by this version does not restore on an older version, as with every earlier schema change.
- The JSON data export gains the photo rows. The pictures themselves travel only in full backups.
- A JSON-only restore brings photo rows without their files. Those rows are treated as `Document` rows are in the same case.

### 8. Errors

| Case | Result |
|---|---|
| Not a JPEG, PNG or WebP; HEIC | 400 with a message; nothing stored |
| Over 25 MB or over 100 megapixels | 400 with a message; nothing stored |
| Metadata still present after processing | 400; nothing stored |
| Item not found | 404 |
| Pass expired, closed or full | 410 with the reason |
| Unknown pass | 404, counted by the throttle |
| Too many uploads a minute | 429 |
| Disk full or write failure | 500; no row, no partial file |

## Breaking changes

None to existing endpoints or stored data.

- `POST /api/images/upload` accepts up to 25 MB (was 10 MB) and re-saves the picture without metadata; a client that compared stored bytes to uploaded bytes would see a difference.
- `POST /api/documents/upload` re-saves jpg, png and webp without metadata.
- The JSON data export has a new `photos` key.

## Testing

Automated:

- Processing: a JPEG with GPS data goes in, the stored file has no EXIF, XMP or IPTC and the same pixel dimensions; a sideways phone photo comes out upright; PNG and WebP; HEIC rejected; 25 MB limit; 100-megapixel limit; the preview's size.
- Photos API: upload, list, label, main picture, delete; deleting the main picture clears `imageUrl`; deleting an item removes its photo files; a failed row insert leaves no file.
- Capture pass: created, expires, closed, replaced by a new pass, full at 50, two uploads at once at 49; the creating session ending; the creating account disabled; a token for one item cannot upload to another; the public routes return nothing but the item's name and type; no public route reads, lists or deletes; wrong-token throttle; only a hash is stored.
- Paperwork through a pass creates a document on the right item, including ammunition, supplies and kits.
- Audit: photo events; pass events; uploads through a pass carry the creating account.
- Backup and restore round trip with galleries, on SQLite and PostgreSQL. Key rotation re-encrypts photo files and previews.
- `sharp` runs inside the built Docker image (run the image, not only build it).

Manual, by the user, on a real phone over the local network: scan the code, take a photo with a label, take a paperwork shot, watch both arrive on the laptop, close the pass and see the phone refuse. Steps go in the pull request.

## Out of scope

Editing or cropping, drag-to-reorder, bulk upload from a folder, reading text from receipts, photos on range sessions or builds, reprocessing pictures already stored, converting existing main pictures into gallery photos, HEIC support.

## Risks

- **Memory.** Decoding a large phone photo can take a few hundred megabytes for a moment. Concurrency 1 and the 100-megapixel limit bound it. Not measured.
- **`sharp` on the Alpine image.** It is installed but unused today; the image test in "Testing" is what proves it loads.
- **The token is in the URL path**, as invite links are. It can appear in a reverse proxy's access log for the 15 minutes it is valid.
- **Leftover files.** A crash between deleting a row and deleting its files leaves an encrypted file that nothing refers to. No sweep is included.
