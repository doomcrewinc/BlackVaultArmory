import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { containsInsensitive, matchesLiteralInsensitive, needsLiteralCheck } from "../db/text-search";
import { redactStoredChanges } from "./redact";
import type { AuditAction } from "./actions";

/**
 * The read side of the audit log: filter parsing, cursor-paged listing, and
 * the DTO shape both the admin list and item-history endpoints return.
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "API".
 */

export type AuditActionGroup = "creates" | "edits" | "deletes" | "signins" | "security";

// Every group is an explicit list, typed against AuditAction so a renamed or
// removed action fails typecheck here. `security` is spelled out too, not
// computed as "everything else": the partition test below
// (`covers every AUDIT_ACTIONS entry exactly once`) unions all five groups
// and compares that to AUDIT_ACTIONS — with an explicit `security` list, a
// new action added to actions.ts and left unplaced fails that test instead
// of silently, and invisibly, landing in Security.
const CREATE_ACTIONS: readonly AuditAction[] = ["CREATE"];
const EDIT_ACTIONS: readonly AuditAction[] = ["UPDATE"];
const DELETE_ACTIONS: readonly AuditAction[] = ["DELETE"];
const SIGNIN_ACTIONS: readonly AuditAction[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT"];
const SECURITY_ACTIONS: readonly AuditAction[] = [
  "INVITE_CREATED",
  "INVITE_REDEEMED",
  "ROLE_CHANGED",
  "USER_DISABLED",
  "USER_ENABLED",
  "RESET_LINK_ISSUED",
  "PASSWORD_CHANGED",
  "DIRECT_ACCESS_CHANGED",
  "BACKUP_CREATED",
  "RESTORE",
  "ENCRYPTION_ENABLED",
  "KEY_ROTATED",
  "FILES_ENCRYPTED",
];

export const ACTION_GROUPS: Readonly<Record<AuditActionGroup, readonly AuditAction[]>> = {
  creates: CREATE_ACTIONS,
  edits: EDIT_ACTIONS,
  deletes: DELETE_ACTIONS,
  signins: SIGNIN_ACTIONS,
  security: SECURITY_ACTIONS,
};

function isActionGroup(value: string): value is AuditActionGroup {
  return Object.prototype.hasOwnProperty.call(ACTION_GROUPS, value);
}

export interface AuditFilters {
  /** actorId, exact match. */
  user?: string;
  action?: AuditActionGroup;
  /** entityType, exact match. */
  type?: string;
  /**
   * Inclusive start instant. The UI sends the viewer's LOCAL midnight as a
   * full ISO instant; a bare `YYYY-MM-DD` (back-compat: old links, API
   * callers) means the start of that UTC day.
   */
  from?: Date;
  /**
   * Inclusive end instant. The UI sends the viewer's LOCAL 23:59:59.999 as a
   * full ISO instant; a bare `YYYY-MM-DD` (back-compat) means the end of that
   * UTC day (23:59:59.999Z).
   */
  to?: Date;
  /** Matches entityLabel, case-insensitive on both providers. */
  q?: string;
  /** `"<at ISO>_<id>"` of the last row already seen. */
  cursor?: string;
  /**
   * entityId, exact match. Not produced by `parseAuditFilters` (there is no
   * `?entityId=` query param) — the item-history route sets it from its
   * path params alongside `type`.
   */
  entityId?: string;
}

export interface AuditEventDto {
  id: string;
  at: string;
  actorId: string | null;
  actorName: string;
  actorIp: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  changes: unknown | null;
}

const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

/** True if `value` contains a NUL byte. Postgres rejects one outright (22021, invalid byte sequence for UTF8), and no stored field can legitimately contain one either, so it always means "reject this value", never "pass it through". */
export function hasNulByte(value: string): boolean {
  return value.includes("\u0000");
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Strictly `YYYY-MM-DD`, year 1970–9999, with no calendar rollover: the
 * whole string must match (no trailing text, e.g. `2026-09-29junk`), the
 * year must be in range (`0000-00-00` is out of range on both counts), and
 * `Date.UTC` must echo back the same year/month/day (`2026-02-31` would
 * otherwise silently become 2026-03-03).
 */
function parseUtcDayStart(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const match = DAY_PATTERN.exec(raw.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date;
}

function parseUtcDayEnd(raw: string | null): Date | undefined {
  const start = parseUtcDayStart(raw);
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
}

interface ParsedCursor {
  at: Date;
  id: string;
}

const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;

/**
 * Strictly the shape `Date#toISOString()` produces for a 4-digit year — the
 * shape every cursor this module issues actually has. `new Date(string)`
 * also accepts the extended-year ISO forms (`+275760-...`, `-271821-...`,
 * the representable extremes of the `Date` type), which Prisma cannot bind
 * and would otherwise surface as an uncaught 500; this rejects those, any
 * year outside 1970–9999, and any calendar-invalid value, the same way
 * `parseUtcDayStart` does for a bare date.
 */
function parseStrictIsoUtc(raw: string): Date | undefined {
  const match = ISO_UTC_PATTERN.exec(raw);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second, millis] = match.slice(1).map(Number);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== millis
  ) {
    return undefined;
  }
  return date;
}

/** `"<at ISO>_<id>"` → `{ at, id }`, or null if malformed, out of range, or carrying a NUL byte — never throws. */
function parseCursor(raw: string): ParsedCursor | null {
  const separator = raw.lastIndexOf("_");
  if (separator <= 0 || separator === raw.length - 1) return null;
  const id = raw.slice(separator + 1);
  if (hasNulByte(id)) return null;
  const at = parseStrictIsoUtc(raw.slice(0, separator));
  return at ? { at, id } : null;
}

function encodeCursor(at: Date, id: string): string {
  return `${at.toISOString()}_${id}`;
}

/**
 * Query-string filters for `GET /api/admin/audit` and the export route.
 * Every value is optional and independently validated: an invalid or
 * unrecognised value is dropped rather than thrown.
 */
export function parseAuditFilters(searchParams: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};

  const user = searchParams.get("user")?.trim();
  if (user && !hasNulByte(user)) filters.user = user;

  const action = searchParams.get("action")?.trim();
  if (action && isActionGroup(action)) filters.action = action;

  const type = searchParams.get("type")?.trim();
  if (type && !hasNulByte(type)) filters.type = type;

  // The browser sends the VIEWER'S local day as a full ISO
  // instant (local midnight for `from`, local 23:59:59.999 for `to` —
  // AuditFilters.tsx / page.tsx's toQueryString), because a bare UTC day
  // uses UTC's calendar boundary instead of the viewer's and
  // drops evening events. A bare `YYYY-MM-DD` is still accepted for
  // back-compat (a bookmarked link, or a caller that never had a browser
  // timezone to convert with) and keeps its old UTC-day meaning.
  const fromRaw = searchParams.get("from");
  const from = (fromRaw && parseStrictIsoUtc(fromRaw.trim())) || parseUtcDayStart(fromRaw);
  if (from) filters.from = from;

  const toRaw = searchParams.get("to");
  const to = (toRaw && parseStrictIsoUtc(toRaw.trim())) || parseUtcDayEnd(toRaw);
  if (to) filters.to = to;

  const q = searchParams.get("q")?.trim();
  if (q && !hasNulByte(q)) filters.q = q;

  const cursor = searchParams.get("cursor")?.trim();
  if (cursor && parseCursor(cursor)) filters.cursor = cursor;

  return filters;
}

type RawEvent = {
  id: string;
  at: Date;
  actorId: string | null;
  actorName: string;
  actorIp: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  changes: string | null;
};

function toDto(event: RawEvent): AuditEventDto {
  let changes: unknown = null;
  if (event.changes) {
    try {
      // redact.ts's contract covers the READ path too ("never render one,
      // even one that predates this rule") — the write path already redacts
      // every sensitive field, but this DTO mapper does not trust that: a
      // row from before this rule existed, or written outside the audited
      // client, must still never leak a sensitive value through the API or
      // CSV export, both of which read `AuditEventDto.changes`.
      changes = redactStoredChanges(JSON.parse(event.changes));
    } catch {
      changes = null;
    }
  }
  return {
    id: event.id,
    at: event.at.toISOString(),
    actorId: event.actorId,
    actorName: event.actorName,
    actorIp: event.actorIp,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    entityLabel: event.entityLabel,
    changes,
  };
}

function buildWhere(filters: AuditFilters): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [];

  if (filters.user) and.push({ actorId: filters.user });
  if (filters.action) and.push({ action: { in: [...ACTION_GROUPS[filters.action]] } });
  if (filters.type) and.push({ entityType: filters.type });
  if (filters.entityId) and.push({ entityId: filters.entityId });
  if (filters.q) and.push({ entityLabel: containsInsensitive(filters.q) });

  if (filters.from || filters.to) {
    const range: Prisma.DateTimeFilter = {};
    if (filters.from) range.gte = filters.from;
    if (filters.to) range.lte = filters.to;
    and.push({ at: range });
  }

  if (filters.cursor) {
    const parsed = parseCursor(filters.cursor);
    if (parsed) {
      and.push({
        OR: [{ at: { lt: parsed.at } }, { at: parsed.at, id: { lt: parsed.id } }],
      });
    }
  }

  return and.length ? { AND: and } : {};
}

/**
 * Most rows one `listAuditEvents` call reads from SQLite while re-checking a
 * `q` that holds `%` or `_`. Ten 500-row queries is a few tens of
 * milliseconds on SQLite and short enough not to hold its single connection
 * against other requests; a log with rarer matches than that is walked over
 * several calls, each continuing from the `nextCursor` it returns.
 */
export const MAX_LITERAL_SCAN_ROWS = 5000;
const LITERAL_SCAN_BATCH = 500;

/**
 * Reads batches in the list order from `filters.cursor`, keeping the rows whose
 * label contains `term` literally, until `wanted` are found, the log ends, or
 * `MAX_LITERAL_SCAN_ROWS` rows were read. `boundary` is the cursor of the last
 * row read when the cap ended the scan, else null.
 */
async function scanForLiteralMatches(
  filters: AuditFilters,
  term: string,
  wanted: number,
): Promise<{ matches: RawEvent[]; boundary: string | null }> {
  const matches: RawEvent[] = [];
  const batchSize = Math.max(wanted, LITERAL_SCAN_BATCH);
  let cursor = filters.cursor;
  let scanned = 0;
  while (matches.length < wanted && scanned < MAX_LITERAL_SCAN_ROWS) {
    const take = Math.min(batchSize, MAX_LITERAL_SCAN_ROWS - scanned);
    // Each batch starts where the previous one ended, so the reads are sequential by nature.
    const batch = (await prisma.auditEvent.findMany({
      where: buildWhere({ ...filters, cursor }),
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take,
    })) as RawEvent[];
    matches.push(...batch.filter((row) => matchesLiteralInsensitive(row.entityLabel, term)));
    const last = batch.at(-1);
    if (!last || batch.length < take) return { matches, boundary: null }; // the log is exhausted
    scanned += batch.length;
    cursor = encodeCursor(last.at, last.id);
  }
  return { matches, boundary: matches.length < wanted ? cursor ?? null : null };
}

/**
 * Newest first (`at desc, id desc` — `id` breaks ties among events sharing
 * the same `at`, which is what keeps the cursor free of duplicates/gaps when
 * several events share a timestamp). Fetches `limit + 1` rows to know
 * whether another page follows without a separate count query.
 *
 * SQLite cannot make `contains` literal, so for a `q` holding `%` or `_` the
 * rows the database returns are re-checked here (ASCII-case-insensitive, as
 * SQLite's LIKE is; PostgreSQL's ILIKE folds by locale, a difference that
 * predates this check). That scan reads at most `MAX_LITERAL_SCAN_ROWS` rows
 * per call: if it ends there before `limit + 1` matches are found, the page is
 * SHORT (possibly empty) but `nextCursor` is non-null and marks where the scan
 * stopped. So a short page does not mean the end of the log; only a null
 * `nextCursor` does.
 */
export async function listAuditEvents(
  filters: AuditFilters,
  limit = 50,
): Promise<{ events: AuditEventDto[]; nextCursor: string | null }> {
  const wanted = limit + 1;
  const exactQ = filters.q !== undefined && needsLiteralCheck(filters.q) ? filters.q : undefined;

  if (exactQ === undefined) {
    const rows = (await prisma.auditEvent.findMany({
      where: buildWhere(filters),
      orderBy: [{ at: "desc" }, { id: "desc" }],
      take: wanted,
    })) as RawEvent[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return { events: page.map(toDto), nextCursor: hasMore && last ? encodeCursor(last.at, last.id) : null };
  }

  const { matches, boundary } = await scanForLiteralMatches(filters, exactQ, wanted);

  if (matches.length > limit) {
    const page = matches.slice(0, limit);
    const last = page.at(-1);
    return { events: page.map(toDto), nextCursor: last ? encodeCursor(last.at, last.id) : null };
  }
  return { events: matches.map(toDto), nextCursor: boundary };
}
