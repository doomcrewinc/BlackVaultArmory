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
 * Client-safe: nothing here reads the database, so the list screens, the add
 * forms and the side menu can all import it.
 */

const LOWERCASE_WORDS = new Set(["a", "an", "and", "or", "of", "the", "to"]);

/**
 * Title Case for a label built from a noun: "food or water item" becomes "Food
 * or Water Item". Small words stay lowercase unless first; the rest of each
 * word is left as written, so "AOW" survives.
 */
export function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word, index) =>
      index > 0 && LOWERCASE_WORDS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
}

/** The add form each kind of row is created on. */
export const ADD_FORM_PATHS: Record<AddFormKind, string> = {
  accessory: "/accessories/new",
  gear: "/gear/new",
  supply: "/supplies/new",
};

/**
 * The value of `?section=` when the address carries exactly one. An empty
 * value, a repeated parameter or none at all is "no section".
 */
export function sectionParam(params: {
  getAll(name: string): string[];
}): string | null {
  const all = params.getAll("section");
  return all.length === 1 && all[0] ? all[0] : null;
}

/**
 * Every string a list screen builds around the name of its rows. Labels
 * (buttons, the stat) are Title Case; the empty title, the hint and the
 * filter message are sentences.
 */
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
    addLabel: `Add ${titleCase(noun.singular)}`,
    addHref,
    emptyTitle: `No ${noun.plural} yet`,
    emptyHint: noun.emptyHint,
    addFirstLabel:
      noun.addFirstLabel ?? `Add First ${titleCase(noun.singular)}`,
    totalLabel: `Total ${titleCase(noun.plural)}`,
    noMatch: `No ${noun.plural} match the selected filter.`,
  };
}

/**
 * What each list screen says when it is not showing a section: the standalone
 * /accessories page, and any caller that passes no wording.
 */
export const DEFAULT_LIST_WORDING: Record<AddFormKind, ListWording> = {
  accessory: {
    ...listWordingFromNoun(
      {
        singular: "accessory",
        plural: "accessories",
        emptyHint:
          "Add parts, optics, suppressors and other attachments to track round counts and build configurations.",
      },
      ADD_FORM_PATHS.accessory,
    ),
    totalLabel: "Total Parts",
  },
  gear: {
    ...listWordingFromNoun(
      {
        singular: "item",
        plural: "items",
        emptyHint:
          "Add knives, cases and other standalone kit to track what you own.",
      },
      ADD_FORM_PATHS.gear,
    ),
    addLabel: "Add Gear",
    emptyTitle: "No gear yet",
  },
  supply: listWordingFromNoun(
    {
      singular: "supply",
      plural: "supplies",
      emptyHint:
        "Track consumables here — quantity, low-stock alerts and expiry dates.",
    },
    ADD_FORM_PATHS.supply,
  ),
};

/**
 * The wording of one list block on a section page. The add link carries the
 * section so the form can preset its type or category and send the person
 * back here. A section with no words for that kind gets the default wording.
 */
export function listWordingForSection(
  section: CategorySection,
  kind: AddFormKind,
): ListWording {
  const noun = sectionNounFor(section, kind);
  return noun
    ? listWordingFromNoun(
        noun,
        `${ADD_FORM_PATHS[kind]}?section=${encodeURIComponent(section.slug)}`,
      )
    : DEFAULT_LIST_WORDING[kind];
}

/** What an add form needs to know about the section the person came from. */
export type AddFormContext = {
  section: CategorySection;
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
  const noun = sectionNounFor(section, kind);
  const allowedValues = sectionAllowedValues(section, kind);
  if (!noun || allowedValues.length === 0) return null;
  return {
    section,
    singular: noun.singular,
    sectionLabel: section.label,
    returnHref: sectionHref(section),
    allowedValues,
  };
}

/**
 * The section an add form's address names: only the three add-form paths
 * count, and only with a section that form can add to.
 */
export function addFormSectionForAddress(
  pathname: string,
  slug: string | null,
): CategorySection | null {
  const kind = (Object.keys(ADD_FORM_PATHS) as AddFormKind[]).find(
    (candidate) => ADD_FORM_PATHS[candidate] === pathname,
  );
  return kind ? (addFormContext(kind, slug)?.section ?? null) : null;
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
  return (section && sectionNounFor(section, kind)?.singular) || kind;
}
