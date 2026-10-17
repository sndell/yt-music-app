import { useLocation } from "wouter";
import type { ExploreItem, ExploreSection } from "@/lib/api/types";
import { usePlayer } from "@/features/player";
import { Empty, LoadError, Loading } from "../components/States";
import { ExploreRow } from "../components/ExploreRow";
import { useExplore } from "../hooks/useExplore";
import { exploreHref, exploreTrack, isPlayableItem } from "../lib/exploreTarget";

/**
 * `/explore`: YouTube Music's Explore page, section by section, in the feed's
 * own order. The feed overlaps the Home shelves, but it is the same five
 * sections for every account and it does not reshuffle within minutes the way
 * Home does, so the page is worth its own route.
 */
export const Explore = () => {
  const { sections, error, reload } = useExplore();
  const [, navigate] = useLocation();
  const { currentSong, playTracks } = usePlayer();

  const openItem = (item: ExploreItem) => {
    const href = exploreHref(item);
    if (href) navigate(href);
  };

  const playFrom = (section: ExploreSection, item: ExploreItem) => {
    const playable = section.items.filter(isPlayableItem).map(exploreTrack).filter((track) => track.videoId);
    const track = playable.find((row) => row.videoId === item.videoId);
    if (!track) return;
    // The clicked row leads and the rest of its chart follows, the way the
    // search page plays a clicked result with the results around it.
    playTracks([track, ...playable.filter((row) => row.videoId !== track.videoId)]);
  };

  const hasContent = sections !== null && sections.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <h1 className="text-2xl font-bold">Explore</h1>
          {/* Sections outrank an error: a stale one must never cover rows that
              did land. With nothing fetched, the error still speaks first. */}
          {hasContent ? (
            <div className="mt-4 flex flex-col gap-8">
              {sections.map((section) => (
                <ExploreRow
                  key={section.key}
                  section={section}
                  currentVideoId={currentSong?.videoId}
                  onOpen={openItem}
                  onPlay={(item) => playFrom(section, item)}
                />
              ))}
            </div>
          ) : error ? (
            <LoadError message={error} onRetry={reload} />
          ) : sections === null ? (
            <Loading label="Loading Explore" />
          ) : (
            <Empty message="YouTube Music returned no Explore sections for this account." onRetry={reload} />
          )}
        </div>
      </div>
    </div>
  );
};
