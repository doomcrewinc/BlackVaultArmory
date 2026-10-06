import Link from "next/link";
import { Loader2, Plus } from "lucide-react";
import { titleCase } from "@/lib/sections/wording";
import type { AddFormState } from "./useAddFormContext";

/** Where Cancel goes when the form was not opened from a section. */
const CANCEL_HREF = {
  accessory: "/accessories",
  gear: "/gear",
  supply: "/",
} as const;

type Props = Readonly<{
  form: AddFormState;
  loading: boolean;
}>;

/** The Cancel link and submit button that end every add form. */
export function AddFormActions({ form, loading }: Props) {
  return (
    <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3 pt-2">
      <Link
        href={form.context?.returnHref ?? CANCEL_HREF[form.kind]}
        className="w-full sm:w-auto text-center px-4 py-2 text-sm text-vault-text-muted hover:text-vault-text border border-vault-border rounded-md hover:border-vault-text-muted/30 transition-colors"
      >
        Cancel
      </Link>
      <button
        type="submit"
        disabled={loading}
        className="w-full sm:w-auto justify-center flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2 rounded-md text-sm font-medium transition-colors"
      >
        {loading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Plus className="w-4 h-4" />
        )}
        {loading ? "Adding..." : `Add ${titleCase(form.noun)}`}
      </button>
    </div>
  );
}
