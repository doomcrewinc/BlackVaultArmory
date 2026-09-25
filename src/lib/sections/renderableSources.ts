import type { SectionGroup, SectionSource } from "@/lib/categories";

/**
 * Which source kinds each group's VIEW can actually put on screen.
 *
 * "The loader can fetch it" and "the view can show it" are different claims,
 * and `sectionIsRenderable` has to make both. A gear- or prep-group section
 * given a `firearm` source passes every loader check — `firearmWhereForSection`
 * returns a perfectly good fragment and `loadSectionItems` queries with it —
 * and then `PayloadList` in `SectionView` throws during RENDER, because the
 * section view has no firearm branch. Verified empirically by temporarily
 * giving `armor` a firearm source: HTTP 500 through `src/app/error.tsx`, not a
 * retry link.
 *
 * This file is the ONE definition of that view-side half. It is NOT a
 * hand-maintained mirror of the view: `SectionView.tsx` types its renderable
 * dispatch as `Extract<SectionPayload, { kind: SectionViewSource }>` and
 * switches exhaustively over it, so the two cannot drift in either direction
 * without a tsc error —
 *
 *   - a kind added here with no branch in the view  → the switch stops being
 *     exhaustive and the function lacks an ending return (TS2366);
 *   - a kind removed here that the view still handles → that `case` is no
 *     longer comparable to the narrowed union (TS2678);
 *   - a kind added to `SectionPayload` and to neither → it survives the view's
 *     `firearm` narrowing and is not assignable to the dispatch's prop.
 *
 * A list that pins itself by convention is the shape this project has already
 * paid for twice (DATE_ONLY_FIELDS, REQUIRED_BACKUP_KEYS). This one is pinned
 * by the compiler.
 *
 * The import above is type-only, so the cycle with `categories.ts` (which
 * imports `isRenderableSource` from here) exists only at type level and is
 * erased from the emitted module graph.
 */

/** What `src/components/sections/SectionView.tsx` renders. */
export const SECTION_VIEW_SOURCES = [
  "accessory",
  "gear",
  "supply",
  "kit",
] as const satisfies readonly SectionSource[];

export type SectionViewSource = (typeof SECTION_VIEW_SOURCES)[number];

/**
 * What `/vault/category/[slug]` renders. That page does not take payloads at
 * all: it hands `VaultClientPage` a slug and the client fetches
 * `/api/firearms?section=<slug>`, so firearms are the only thing it can show.
 * A vault section given a gear or supply source would load rows nobody
 * renders — the silent-omission shape, one group over.
 */
export const VAULT_VIEW_SOURCES = [
  "firearm",
] as const satisfies readonly SectionSource[];

/**
 * Keyed by group rather than global, because the two views differ: the vault's
 * nine sections render firearms through `VaultClientPage`, every other group
 * renders through `SectionView`. `satisfies Record<SectionGroup, …>` means a
 * group added to `SECTION_GROUPS` without a view is a tsc error here.
 */
export const RENDERABLE_SOURCES_BY_GROUP = {
  vault: VAULT_VIEW_SOURCES,
  gear: SECTION_VIEW_SOURCES,
  prep: SECTION_VIEW_SOURCES,
} as const satisfies Record<SectionGroup, readonly SectionSource[]>;

/** Whether the view serving `group` has a renderer for `kind`. */
export function isRenderableSource(
  group: SectionGroup,
  kind: SectionSource,
): boolean {
  const renderable: readonly SectionSource[] =
    RENDERABLE_SOURCES_BY_GROUP[group];
  return renderable.includes(kind);
}
