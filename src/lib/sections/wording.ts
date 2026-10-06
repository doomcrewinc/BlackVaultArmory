import {
  gearSectionForAccessory,
  gearSectionForItem,
  sectionAllowedValues,
  sectionBySlug,
  sectionHref,
  sectionNounFor,
  sectionSources,
  supplySectionForItem,
  type AddFormKind,
  type CategorySection,
  type SectionNoun,
} from "@/lib/categories";

/**
 * Client-safe: nothing here reads the database, so the list screens and the
 * add forms can both import it.
 */

/** The add form each kind of row is created on. */
export const ADD_FORM_PATHS: Record<AddFormKind, string> = {
  accessory: "/accessories/new",
  gear: "/gear/new",
  supply: "/supplies/new",
};

/** Every string a list screen builds around the name of its rows. */
export type ListWording = {
  addLabel: string;
  addHref: string;
  emptyTitle: string;
  emptyHint: string;
  addFirstLabel: string;
  totalLabel: string;
  noMatch: string;
};

/** The wording for rows named by `noun`, adding through `addHref`. */
export function listWordingFromNoun(
  noun: SectionNoun,
  addHref: string,
): ListWording {
  return {
    addLabel: `Add ${noun.singular}`,
    addHref,
    emptyTitle: `No ${noun.plural} yet`,
    emptyHint: noun.emptyHint,
    addFirstLabel: `Add first ${noun.singular}`,
    totalLabel: `Total ${noun.plural}`,
    noMatch: `No ${noun.plural} match the selected filter.`,
  };
}

/**
 * The wording of one list block on a section page. The add link carries the
 * section so the form can preset its type or category and send the person
 * back here.
 */
export function listWordingForSection(
  section: CategorySection,
  kind: AddFormKind,
): ListWording {
  return listWordingFromNoun(
    sectionNounFor(section, kind),
    `${ADD_FORM_PATHS[kind]}?section=${encodeURIComponent(section.slug)}`,
  );
}

/** What an add form needs to know about the section the person came from. */
export type AddFormContext = {
  singular: string;
  sectionLabel: string;
  /** Built from the registry's group and slug, never from the query string. */
  returnHref: string;
  /** Type or category values the section holds; never empty. */
  allowedValues: string[];
};

/**
 * The section a query-string value names, when it names one that this add form
 * can create rows for: a gear or preparedness section with a source of the
 * form's kind. Anything else (an unknown slug, a firearm section, a section of
 * another kind, an absent value) is null and the form behaves as it does with
 * no section at all.
 */
export function addFormContext(
  kind: AddFormKind,
  slug: string | null | undefined,
): AddFormContext | null {
  if (!slug) return null;
  const section = sectionBySlug(slug);
  if (!section || section.group === "vault") return null;
  if (!sectionSources(section).includes(kind)) return null;
  const allowedValues = sectionAllowedValues(section, kind);
  if (allowedValues.length === 0) return null;
  return {
    singular: sectionNounFor(section, kind).singular,
    sectionLabel: section.label,
    returnHref: sectionHref(section),
    allowedValues,
  };
}

/** The section an existing row belongs to, from its type or category. */
export function sectionForItem(
  kind: AddFormKind,
  value: string,
): CategorySection | undefined {
  switch (kind) {
    case "accessory":
      return gearSectionForAccessory({ type: value });
    case "gear":
      return gearSectionForItem({ category: value });
    case "supply":
      return supplySectionForItem({ category: value });
  }
}

/**
 * What to call an existing row: its section's singular noun, or the storage
 * name when no section holds it.
 */
export function itemNoun(kind: AddFormKind, value: string): string {
  const section = sectionForItem(kind, value);
  return section ? sectionNounFor(section, kind).singular : kind;
}

/** "magazine" to "Magazine", for a label that starts a sentence. */
export function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
