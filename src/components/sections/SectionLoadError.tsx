import Link from "next/link";

/**
 * The retry UI for a page whose data load threw.
 *
 * Now the only copy in the tree. There were six: the two `[slug]` section
 * pages (three of them in `/gear/[slug]` alone, one per source branch),
 * `/accessories`, `/builds` and `/supplies/item/[id]`. They had already
 * drifted — the standalone three wrote `text-vault-text-muted text-sm` and
 * `flex flex-col items-center` where the section pages wrote `text-sm
 * text-vault-text-muted` and `flex min-h-[60vh] flex-col`. Same rendered
 * result, three spellings, which is how the next divergence goes unnoticed.
 *
 * `href` is the page's own path, so "Tap to retry" re-requests the page the
 * user is already on rather than navigating them somewhere else.
 */
export function SectionLoadError({
  label,
  href,
}: {
  label: string;
  href: string;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="text-sm text-vault-text-muted">Failed to load {label}.</p>
      <Link href={href} className="text-sm text-[#00C2FF] hover:underline">
        Tap to retry
      </Link>
    </div>
  );
}
