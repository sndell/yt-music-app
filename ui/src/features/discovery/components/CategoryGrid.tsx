import type { MoodSection } from "@/lib/api/types";
import { MoodTile } from "./MoodTile";

/**
 * One YouTube section of category tiles. Moods & genres is section titles with
 * a tile grid under each, in YouTube's own order.
 */
export const CategoryGrid = ({ section }: { section: MoodSection }) => (
  <section className="min-w-0">
    <h2 className="text-xl font-bold">{section.title}</h2>
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-5">
      {section.categories.map((category) => (
        <MoodTile key={category.params} category={category} />
      ))}
    </div>
  </section>
);
