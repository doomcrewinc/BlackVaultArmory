import { NewAccessoryForm } from "./NewAccessoryForm";

type SearchParams = Promise<{ section?: string | string[] }>;

export default async function NewAccessoryPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const { section } = await searchParams;
  return (
    <NewAccessoryForm section={Array.isArray(section) ? section[0] : section} />
  );
}
