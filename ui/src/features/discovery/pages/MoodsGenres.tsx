import { CategoryGrid } from "../components/CategoryGrid";
import { Empty, LoadError, Loading } from "../components/States";
import { useMoodCategories } from "../hooks/useMoodCategories";

/**
 * `/moods`: YouTube Music's own groupings ("For you", "Moods & moments",
 * "Genres"), each a grid of category tiles in YouTube's order.
 */
export const MoodsGenres = () => {
  const { sections, error, reload } = useMoodCategories();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <h1 className="text-2xl font-bold">Moods &amp; genres</h1>
          {error ? (
            <LoadError message={error} onRetry={reload} />
          ) : sections === null ? (
            <Loading label="Loading moods and genres" />
          ) : sections.length === 0 ? (
            <Empty message="YouTube Music returned no moods or genres for this account." onRetry={reload} />
          ) : (
            <div className="mt-4 flex flex-col gap-8">
              {sections.map((section) => (
                <CategoryGrid key={section.title} section={section} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
