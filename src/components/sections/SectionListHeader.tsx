import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionBlockHeader } from "@/components/sections/SectionBlockHeader";
import type { ListWording } from "@/lib/sections/wording";

type Props = Readonly<{
  heading: string;
  /** Shown under the heading of a page; a block header has no subtitle. */
  subtitle: string;
  wording: ListWording;
  /**
   * True when the list is one block of a multi-source section page: the page
   * owns the `h1`, so the block gets the lighter SectionBlockHeader.
   */
  embedded: boolean;
}>;

/** A list screen's header, with the Add link built from its wording. */
export function SectionListHeader({
  heading,
  subtitle,
  wording,
  embedded,
}: Props) {
  const addAction = (
    <Link
      href={wording.addHref}
      className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-3 py-1.5 rounded text-sm font-medium transition-colors"
    >
      <Plus className="w-4 h-4" />
      {wording.addLabel}
    </Link>
  );
  return embedded ? (
    <SectionBlockHeader title={heading} action={addAction} />
  ) : (
    <PageHeader title={heading} subtitle={subtitle} actions={addAction} />
  );
}
