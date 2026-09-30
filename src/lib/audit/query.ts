import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { containsInsensitive } from "../db/text-search";
import { AUDIT_ACTIONS, type AuditAction } from "./actions";

/**
 * The read side of the audit log: filter parsing, cursor-paged listing, and
 * the DTO shape both the admin list and item-history endpoints return.
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "API".
 */

export type AuditActionGroup = "creates" | "edits" | "deletes" | "signins" | "security";

// Derived from AUDIT_ACTIONS (src/lib/audit/actions.ts), not from literal
// strings: each group is typed against AuditAction, so a renamed or removed
// action fails typecheck here instead of silently dropping out of every
// group, and `security` is *every remaining action*, computed by filtering
// the others out of the full list rather than spelled out by hand.
const CREATE_ACTIONS: readonly AuditAction[] = ["CREATE"];
const EDIT_ACTIONS: readonly AuditAction[] = ["UPDATE"];
const DELETE_ACTIONS: readonly AuditAction[] = ["DELETE"];
const SIGNIN_ACTIONS: readonly AuditAction[] = ["LOGIN", "LOGIN_FAILED", "LOGOUT"];
const SECURITY_ACTIONS: readonly AuditAction[] = AUDIT_ACTIONS.filter(
  (action) =>
    !CREATE_ACTIONS.includes(action) &&
    !EDIT_ACTIONS.includes(action) &&
    !DELETE_ACTIONS.includes(action) &&
    !SIGNIN_ACTIONS.includes(action),
);

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
  /** Inclusive start of the UTC day. */
  from?: Date;
  /** Inclusive end of the UTC day (23:59:59.999). */
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

/** Accepts `YYYY-MM-DD` or any string `Date` can parse; the date part is read in UTC either way. */
function parseUtcDayStart(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseUtcDayEnd(raw: string | null): Date | undefined {
  const start = parseUtcDayStart(raw);
  return start ? new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1) : undefined;
}

interface ParsedCursor {
  at: Date;
  id: string;
}

/** `"<at ISO>_<id>"` → `{ at, id }`, or null if malformed — never throws. */
function parseCursor(raw: string): ParsedCursor | null {
  const separator = raw.lastIndexOf("_");
  if (separator <= 0 || separator === raw.length - 1) return null;
  const at = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  return Number.isNaN(at.getTime()) ? null : { at, id };
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
  if (user) filters.user = user;

  const action = searchParams.get("action")?.trim();
  if (action && isActionGroup(action)) filters.action = action;

  const type = searchParams.get("type")?.trim();
  if (type) filters.type = type;

  const from = parseUtcDayStart(searchParams.get("from"));
  if (from) filters.from = from;

  const to = parseUtcDayEnd(searchParams.get("to"));
  if (to) filters.to = to;

  const q = searchParams.get("q")?.trim();
  if (q) filters.q = q;

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
      changes = JSON.parse(event.changes);
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
 * Newest first (`at desc, id desc` — `id` breaks ties among events sharing
 * the same `at`, which is what keeps the cursor free of duplicates/gaps when
 * several events share a timestamp). Fetches `limit + 1` rows to know
 * whether another page follows without a separate count query.
 */
export async function listAuditEvents(
  filters: AuditFilters,
  limit = 50,
): Promise<{ events: AuditEventDto[]; nextCursor: string | null }> {
  const rows = (await prisma.auditEvent.findMany({
    where: buildWhere(filters),
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit + 1,
  })) as RawEvent[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.at, last.id) : null;

  return { events: page.map(toDto), nextCursor };
}
