"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { titleCase } from "@/lib/sections/wording";
import type { AddFormState } from "./useAddFormContext";

/** Where Back goes (null: the previous page) and what the form says by default. */
const FORM_COPY = {
  accessory: {
    back: { href: "/accessories", label: "Accessories" },
    intro: "Register a new part or attachment in the arsenal.",
    introForSection: (noun: string) => `Register a new ${noun} in the arsenal.`,
  },
  gear: {
    back: { href: "/gear", label: "Gear" },
    intro: "Register a knife, case or other standalone item in the arsenal.",
    introForSection: (noun: string) => `Register a new ${noun} in the arsenal.`,
  },
  supply: {
    back: null,
    intro:
      "Track a consumable — cleaning supplies, medical, food, water and the rest.",
    introForSection: (noun: string) =>
      `Track a new ${noun}: quantity, low-stock alerts and expiry dates.`,
  },
} as const;

const BACK_CLASS =
  "flex items-center gap-1.5 text-vault-text-muted hover:text-vault-text text-sm transition-colors";

/**
 * The breadcrumb bar of an add form. Back returns to the section the form was
 * opened from, else to the page the form's kind has always returned to.
 */
export function AddFormBreadcrumb({ form }: Readonly<{ form: AddFormState }>) {
  const router = useRouter();
  const { context, noun } = form;
  const back = context
    ? { href: context.returnHref, label: context.sectionLabel }
    : FORM_COPY[form.kind].back;
  const backContent = (
    <>
      <ArrowLeft className="w-4 h-4" />
      {back ? `Back to ${back.label}` : "Back"}
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-4 px-4 sm:px-6 py-4 border-b border-vault-border">
      {back ? (
        <Link href={back.href} className={BACK_CLASS}>
          {backContent}
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => router.back()}
          className={BACK_CLASS}
        >
          {backContent}
        </button>
      )}
      <span className="text-vault-border">/</span>
      <h1 className="text-sm font-semibold text-vault-text tracking-wide uppercase">
        Add {titleCase(noun)}
      </h1>
    </div>
  );
}

/** The title, intro and error banner above an add form's fields. */
export function AddFormIntro({
  form,
  error,
}: Readonly<{ form: AddFormState; error: string | null }>) {
  const { context, noun } = form;
  const copy = FORM_COPY[form.kind];
  return (
    <>
      <div className="mb-8">
        <h2 className="text-xl font-bold text-vault-text mb-1">
          New {titleCase(noun)} Entry
        </h2>
        <p className="text-sm text-vault-text-muted">
          {context ? copy.introForSection(noun) : copy.intro}
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 bg-[#E53935]/10 border border-[#E53935]/30 rounded-lg px-4 py-3 mb-6">
          <AlertCircle className="w-4 h-4 text-[#E53935] shrink-0" />
          <p className="text-sm text-[#E53935]">{error}</p>
        </div>
      )}
    </>
  );
}
