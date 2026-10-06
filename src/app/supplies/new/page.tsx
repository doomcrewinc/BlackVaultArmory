import { NewSupplyForm } from "./NewSupplyForm";

type SearchParams = Promise<{ section?: string | string[] }>;

export default async function NewSupplyPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const { section } = await searchParams;
  return (
    <NewSupplyForm section={Array.isArray(section) ? section[0] : section} />
  );
}
