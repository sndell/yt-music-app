import { useState, type ReactNode } from "react";
import { PlaybackButtons, type PlaybackExtraAction, type ShuffleMenuOptions } from "@/components/ui/PlaybackButtons";
import { cn } from "@/util/cn";

const thumbClass = "size-12 shrink-0 rounded-md shadow-md";

const Thumb = ({ url, alt, fallback }: { url?: string; alt: string; fallback: boolean }) => {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={alt}
        onError={fallback ? () => setFailed(true) : undefined}
        className={cn(thumbClass, "object-cover")}
      />
    );
  }

  if (!fallback) return null;

  return (
    <div className={cn(thumbClass, "grid place-items-center bg-primary-light")}>
      <span className="icon-[solar--music-note-linear] text-lg text-primary-dark" />
    </div>
  );
};

export const StickyCollectionBar = ({
  visible,
  background,
  thumbnailUrl,
  thumbnailAlt,
  title,
  meta,
  onPlay,
  onShuffle,
  shuffleMenu,
  extra,
  coverFallback = false,
  columnHeaders = false,
}: {
  visible: boolean;
  background: string;
  thumbnailUrl?: string;
  /** Playlist and Album use the title. Artist passes an empty alt for the banner thumb. */
  thumbnailAlt?: string;
  title: string;
  meta?: ReactNode;
  onPlay?: () => void;
  onShuffle?: () => void;
  /** Album and Playlist: the Shuffle control opens a menu with both shuffles. */
  shuffleMenu?: ShuffleMenuOptions;
  extra?: PlaybackExtraAction | PlaybackExtraAction[];
  /** Album and Artist show a note icon when the thumb is missing or fails. Playlist leaves the slot empty. */
  coverFallback?: boolean;
  /** Track / Album / Duration row. Playlist and Album only. */
  columnHeaders?: boolean;
}) => (
  /*
   * z-30, not z-10: at the bottom of a list the edge-fade mask clears and the
   * scroll container stops being a stacking context, so a z-10 bar would tie
   * with the row wrappers (also z-10) and lose to DOM order, letting songs
   * paint over it.
   */
  <div
    className="absolute top-0 right-0 left-0 z-30 bg-primary transition-transform duration-300"
    style={{
      transform: visible ? "translateY(0)" : "translateY(-100%)",
      opacity: visible ? 1 : 0,
    }}
  >
    <div className="flex gap-3 items-center p-3 w-full backdrop-blur-2xl" style={{ background }}>
      <Thumb key={thumbnailUrl ?? "empty"} url={thumbnailUrl} alt={thumbnailAlt ?? title} fallback={coverFallback} />
      <div className="min-w-0 flex-1">
        <h2 title={title} className="truncate text-xl font-bold">
          {title}
        </h2>
        {meta}
      </div>
      <PlaybackButtons variant="icon" onPlay={onPlay} onShuffle={onShuffle} shuffleMenu={shuffleMenu} extra={extra} />
    </div>
    {columnHeaders && (
      <div className="grid grid-cols-[5fr_1fr] border-y border-primary bg-secondary px-3 py-1.5 sm:px-4 md:grid-cols-[7fr_5fr_1fr]">
        <div>Track</div>
        <div className="max-md:hidden">Album</div>
        <div className="justify-self-end">Duration</div>
      </div>
    )}
  </div>
);
