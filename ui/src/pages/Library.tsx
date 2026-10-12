import { PageHeading } from "@/components/ui/PageHeading";

export const Library = () => {
  return (
    <div className="flex justify-center">
      <div className="w-full max-w-7xl p-1.5 px-3">
        <PageHeading>Library</PageHeading>
        <p className="text-sm text-primary-dark">This library is empty.</p>
      </div>
    </div>
  );
};
