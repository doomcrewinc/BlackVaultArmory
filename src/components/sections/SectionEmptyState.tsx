import Link from "next/link";
import { Plus, type LucideIcon } from "lucide-react";
import type { ListWording } from "@/lib/sections/wording";

type Props = Readonly<{
  icon: LucideIcon;
  wording: ListWording;
}>;

/** What a list screen shows when it has no rows at all. */
export function SectionEmptyState({ icon: Icon, wording }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="w-16 h-16 rounded-full bg-[#00C2FF]/10 border border-[#00C2FF]/20 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-[#00C2FF]" />
      </div>
      <h3 className="text-lg font-semibold text-vault-text mb-2">
        {wording.emptyTitle}
      </h3>
      <p className="text-sm text-vault-text-muted mb-6 max-w-sm">
        {wording.emptyHint}
      </p>
      <Link
        href={wording.addHref}
        className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-4 py-2 rounded text-sm font-medium transition-colors"
      >
        <Plus className="w-4 h-4" />
        {wording.addFirstLabel}
      </Link>
    </div>
  );
}
