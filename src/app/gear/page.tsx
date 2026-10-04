import { PageHeader } from "@/components/shared/PageHeader";
import { SectionCardGrid } from "@/components/sections/SectionCardGrid";

export default function GearPage() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader title="GEAR" subtitle="Everything that is not a firearm" />
      <SectionCardGrid group="gear" />
    </div>
  );
}
