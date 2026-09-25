import type { ReactNode } from "react";

/**
 * The header one list block gets when a section renders more than one source
 * — a plate carrier and a pack of chest seals are not interchangeable rows,
 * so each list says which it is.
 *
 * Deliberately lighter than `PageHeader`: the page already has one `h1` for
 * the section, and a second full-width bordered header per block would read
 * as two pages stacked. The list component's own "Add …" action rides along
 * here, because suppressing `PageHeader` would otherwise take the only way
 * to add an item on a mixed section page with it.
 */
export function SectionBlockHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-6 sm:px-6">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted">
        {title}
      </h2>
      {action}
    </div>
  );
}
