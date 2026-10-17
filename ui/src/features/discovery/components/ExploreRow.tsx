import { Link } from "wouter";
import type { ExploreItem, ExploreSection } from "@/lib/api/types";
import { SnapRow } from "@/components/ui/SnapRow";
import { TrackRow } from "@/components/ui/TrackRow";
import { ExploreCard } from "./ExploreCard";
import { MoodTile } from "./MoodTile";
import { isPlayableItem } from "../lib/exploreTarget";

/**
 * One Explore section, drawn the way the payload says: cards in a snapping row,
 * charts as song rows, or moods as tiles that link into the moods and genres
 * page. Nothing here decides a layout from a title, because YouTube's titles
 * move and the payload already carries the shape.
 */
export const ExploreRow = ({
  section,
  currentVideoId,
  onOpen,
  onPlay,
}: {
  section: ExploreSection;
  currentVideoId: string | undefined;
  onOpen: (item: ExploreItem) => void;
  onPlay: (item: ExploreItem) => void;
}) => {
  const activate = (item: ExploreItem) => (isPlayableItem(item) ? onPlay(item) : onOpen(item));

  return (
    <section className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{section.title}</h2>
        {section.layout === "moods" && (
          <Link
            href="/moods"
            className="flex shrink-0 cursor-pointer items-center gap-1 text-sm font-medium text-primary-dark hover:text-primary"
          >
            See all
            <span className="icon-[solar--alt-arrow-right-linear]" />
          </Link>
        )}
      </div>

      {section.layout === "cards" && (
        <SnapRow>
          {section.items.map((item, index) => (
            <ExploreCard
              key={`${section.key}-${item.kind}-${item.videoId ?? item.browseId ?? item.playlistId ?? index}`}
              item={item}
              playing={Boolean(item.videoId) && currentVideoId === item.videoId}
              onActivate={() => activate(item)}
            />
          ))}
        </SnapRow>
      )}

      {section.layout === "songs" && (
        <div className="mt-3 flex flex-col">
          {section.items.map((item, index) => (
            <TrackRow
              key={`${section.key}-${item.videoId ?? index}`}
              title={item.title}
              subtitle={item.subtitle}
              thumbnails={item.thumbnails}
              explicit={item.explicit}
              explicitOnSubtitle
              playing={Boolean(item.videoId) && currentVideoId === item.videoId}
              disabled={!item.videoId}
              reveal={Boolean(item.videoId)}
              onActivate={() => activate(item)}
            />
          ))}
        </div>
      )}

      {section.layout === "moods" && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-5">
          {section.categories.map((category) => (
            <MoodTile key={category.params} category={category} />
          ))}
        </div>
      )}
    </section>
  );
};
