import Link from "next/link";

/**
 * The retry UI the section pages, the supply pages and the accessories and
 * builds pages each carried their own copy of.
 *
 * One component rather than four copies of the same JSX: a section page that
 * fails to load is the same screen wherever it happens, and the copies had
 * already drifted apart on the wrapper classes.
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
