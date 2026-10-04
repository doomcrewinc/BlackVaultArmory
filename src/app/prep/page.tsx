import { PageHeader } from "@/components/shared/PageHeader";
import { SectionCardGrid } from "@/components/sections/SectionCardGrid";

export default function PrepPage() {
  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        title="PREPAREDNESS"
        subtitle="Armor, medical, food, water, power & bugout stores"
      />
      <SectionCardGrid group="prep" />
    </div>
  );
}
