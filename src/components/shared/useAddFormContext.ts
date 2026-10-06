"use client";

import { useSearchParams } from "next/navigation";
import type { AddFormKind } from "@/lib/categories";
import { addFormContext } from "@/lib/sections/wording";

/**
 * The section an add form was opened from (`?section=`), and what to call the
 * thing being added: the section's singular noun, or the storage name when the
 * form was opened with no usable section.
 */
export function useAddFormContext(kind: AddFormKind) {
  const context = addFormContext(kind, useSearchParams().get("section"));
  return { context, noun: context?.singular ?? kind };
}
