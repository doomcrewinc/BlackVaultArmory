import { NewGearForm } from "./NewGearForm";

type SearchParams = Promise<{ section?: string | string[] }>;

export default async function NewGearPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const { section } = await searchParams;
  return (
    <NewGearForm section={Array.isArray(section) ? section[0] : section} />
  );
}
