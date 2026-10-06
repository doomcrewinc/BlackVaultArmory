"use client";

import { useSearchParams } from "next/navigation";
import type { AddFormKind } from "@/lib/categories";
import {
  addFormContext,
  sectionParam,
  titleCase,
  type AddFormContext,
} from "@/lib/sections/wording";

/** What the pieces of an add form need to share. */
export type AddFormState = {
  kind: AddFormKind;
  /** The section the form was opened from; null when none was usable. */
  context: AddFormContext | null;
  /** What to call the thing being added. */
  noun: string;
  /** The label of the name field. */
  nameLabel: string;
};

/** The name field's label when the form was opened with no section. */
const DEFAULT_NAME_LABEL = {
  accessory: "Accessory Name",
  gear: "Item Name",
  supply: "Item Name",
} as const;

/**
 * The section an add form was opened from (`?section=`), and what to call the
 * thing being added: the section's singular noun, or the storage name when the
 * form was opened with no usable section.
 */
export function useAddFormContext(kind: AddFormKind): AddFormState {
  const context = addFormContext(kind, sectionParam(useSearchParams()));
  return {
    kind,
    context,
    noun: context?.singular ?? kind,
    nameLabel: context
      ? `${titleCase(context.singular)} Name`
      : DEFAULT_NAME_LABEL[kind],
  };
}
