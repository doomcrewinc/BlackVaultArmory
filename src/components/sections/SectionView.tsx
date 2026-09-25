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
  heading,
  subheading,
  embedded,
}: {
  payload: SectionPayload;
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
      // No gear-group or prep-group section carries a firearm source, and the
      // vault's sections render through VaultClientPage at
      // /vault/category/[slug], which fetches by slug rather than taking
      // rows. Listed explicitly rather than left to a `default` so the switch
      // stays exhaustive: a kind added to SectionPayload is a tsc error here.
      return null;
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
  if (payloads.length === 1) {
    return (
      <PayloadList
        payload={payloads[0]}
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
      <div className="px-4 pt-4 sm:px-6">
        <SupplyTimezoneNotice timezoneConfigured={timezoneConfigured} />
      </div>
      {payloads.map((payload) => (
        <PayloadList
          key={payload.kind}
          payload={payload}
          heading={BLOCK_LABELS[payload.kind]}
          embedded
        />
      ))}
    </div>
  );
}
