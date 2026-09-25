import { Package } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { AccessoriesClientPage } from "@/app/accessories/AccessoriesClientPage";
import { GearClientPage } from "@/app/gear/GearClientPage";
import { SupplyClientPage } from "@/app/supplies/SupplyClientPage";
import type { CategorySection } from "@/lib/categories";
import type { SectionPayload } from "@/lib/sections/loadSectionItems";

/** The sub-heading one list block carries on a multi-source section page. */
const BLOCK_LABELS: Record<SectionPayload["kind"], string> = {
  firearm: "Firearms",
  accessory: "Accessories",
  gear: "Gear",
  supply: "Supplies",
};

/**
 * One payload's list, with the list component that already renders that kind
 * of row. Nothing is re-implemented here — the section pages and the
 * standalone /gear, /supplies and /accessories pages must not drift apart.
 *
 * An empty payload still renders its list component and that component's own
 * empty state: empty sections appear in the nav with a zero count by spec
 * decision, so hiding the block would make the same information invisible one
 * level down.
 */
function PayloadList({
  payload,
  sectionSlug,
  heading,
  subheading,
  embedded,
}: {
  payload: SectionPayload;
  /** Only used to name the section in the `firearm` branch's throw. */
  sectionSlug: string;
  heading: string;
  subheading?: string;
  embedded: boolean;
}) {
  switch (payload.kind) {
    case "gear":
      return (
        <GearClientPage
          items={payload.items}
          timezoneConfigured={payload.timezoneConfigured}
          heading={heading}
          subheading={subheading}
          embedded={embedded}
        />
      );
    case "supply":
      return (
        <SupplyClientPage
          items={payload.items}
          timezoneConfigured={payload.timezoneConfigured}
          heading={heading}
          subheading={subheading}
          embedded={embedded}
        />
      );
    case "accessory":
      return (
        <AccessoriesClientPage
          accessories={payload.items}
          heading={heading}
          subheading={subheading}
          embedded={embedded}
        />
      );
    case "firearm":
      // The case exists because the switch is exhaustive over SectionPayload
      // with no `default` — a kind added to the payload union is a tsc error
      // here rather than a list that quietly goes missing.
      //
      // It THROWS rather than returning null. No gear-group or prep-group
      // section carries a firearm source today, and the vault's nine sections
      // render through VaultClientPage at /vault/category/[slug], which
      // fetches by slug rather than taking rows — so this is unreachable. But
      // returning null would be the exact silent-omission shape this phase
      // removed from the loader, just relocated into the view: the section
      // would query the database and then render nothing, with no error and
      // no empty state.
      //
      // Where the throw surfaces, verified by temporarily giving `armor` a
      // firearm source: NOT SectionLoadError. The [slug] pages' try/catch
      // wraps only `loadSectionItems`, and this runs later, during render of
      // the JSX they return. It is caught by `src/app/error.tsx`, which
      // probes /api/health, finds the database fine and renders "Something
      // went wrong" with a working "Try again" button. Loud either way, and
      // that boundary also tells a real outage apart from a code defect.
      // Making it render SectionLoadError instead needs a load-phase gate,
      // which is what task 6's `sectionIsRenderable` is for.
      throw new Error(
        `Section "${sectionSlug}" declares a firearm source, which no ` +
          `section renderer handles; firearms render through VaultClientPage ` +
          `at /vault/category/[slug].`,
      );
  }
}

/**
 * Renders every source a section declares.
 *
 * One payload renders its list alone under the section heading, exactly as
 * the single-source pages did before this component existed. More than one
 * gets a page heading plus a labelled block per payload — a plate carrier and
 * a pack of chest seals are not interchangeable rows, so the lists stay
 * separate and say which is which.
 *
 * The timezone notice renders EXACTLY ONCE per page. With one payload the
 * list component owns it; with several, this component renders it and passes
 * `embedded` so the blocks do not each add their own copy.
 *
 * Both gear and supply lists carry it, because both render expiry verdicts.
 * `AppSettings.timezone` ships NULL and no client path sets it, so the host
 * timezone IS the shipped default — a page that says EXPIRED without saying
 * which timezone decided it re-opens exactly what the notice was added to
 * close. This is why `timezoneConfigured` is a REQUIRED prop on both list
 * components rather than an optional one defaulting to `true`: a default
 * would fail open on the next surface that forgets to pass it.
 */
export function SectionView({
  section,
  payloads,
}: {
  section: CategorySection;
  payloads: SectionPayload[];
}) {
  // A section declaring no source at all is a registry defect (task 6 adds
  // the invariant test), but it must not render as a heading above a blank
  // region — the last blank-page shape left in this flow. It gets the same
  // empty state a single empty payload would have produced.
  if (payloads.length === 0) {
    return (
      <div className="min-h-full">
        <PageHeader title={section.label} subtitle={section.description} />
        <div className="p-4 sm:p-6">
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[#00C2FF]/20 bg-[#00C2FF]/10">
              <Package className="h-8 w-8 text-[#00C2FF]" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-vault-text">
              Nothing to show
            </h3>
            <p className="max-w-sm text-sm text-vault-text-muted">
              This section has no items yet.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (payloads.length === 1) {
    return (
      <PayloadList
        payload={payloads[0]}
        sectionSlug={section.slug}
        heading={section.label}
        subheading={section.description}
        embedded={false}
      />
    );
  }

  // Any payload whose verdicts came from an unconfigured timezone puts the
  // notice on the page — once, above every block, not once per block.
  const timezoneConfigured = !payloads.some(
    (payload) =>
      (payload.kind === "gear" || payload.kind === "supply") &&
      payload.items.length > 0 &&
      !payload.timezoneConfigured,
  );

  return (
    <div className="min-h-full">
      <PageHeader title={section.label} subtitle={section.description} />
      {/* Spacing goes on the notice itself rather than a wrapper div: the
          notice renders null when the timezone is configured, when the user
          has dismissed it, and on the server pass before hydration, and a
          wrapper would leave an empty padded strip on the page in all three
          cases. */}
      <SupplyTimezoneNotice
        timezoneConfigured={timezoneConfigured}
        className="mx-4 mt-4 sm:mx-6"
      />
      {payloads.map((payload) => (
        <PayloadList
          key={payload.kind}
          payload={payload}
          sectionSlug={section.slug}
          heading={BLOCK_LABELS[payload.kind]}
          embedded
        />
      ))}
    </div>
  );
}
