import { useState, type ReactNode } from "react";
import { PlaybackButtons, type PlaybackExtraAction, type ShuffleMenuOptions } from "@/components/ui/PlaybackButtons";
import { cn } from "@/util/cn";

const Thumb = ({ url, alt, fallback }: { url?: string; alt: string; fallback: boolean }) => {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={alt}
        onError={fallback ? () => setFailed(true) : undefined}
        className="size-10 shrink-0 rounded-lg object-cover shadow-md"
      />
    );
  }

  if (!fallback) return null;

  return (
    <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-light">
      <span className="icon-[solar--music-note-linear] text-base text-primary-dark" />
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
}: {
  visible: boolean;
  /** Dominant-colour tint for the glass. */
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
}) => (
  /*
   * z-30, not z-10: at the bottom of a list the edge-fade mask clears and the
   * scroll container stops being a stacking context, so a z-10 bar would tie
   * with the row wrappers (also z-10) and lose to DOM order, letting songs
   * paint over it.
   */
  <div
    aria-hidden={!visible}
    className={cn(
      "absolute top-0 right-0 left-0 z-30 transition-[transform,opacity] duration-300",
      !visible && "pointer-events-none",
    )}
    style={{ transform: visible ? "translateY(0)" : "translateY(-100%)", opacity: visible ? 1 : 0 }}
  >
    <div className="flex w-full items-center gap-3 px-4 py-2 backdrop-blur-2xl" style={{ background }}>
      <Thumb
        key={thumbnailUrl ?? "empty"}
        url={thumbnailUrl}
        alt={thumbnailAlt ?? title}
        fallback={coverFallback}
      />
      <div className="min-w-0 flex-1">
        <h2 title={title} className="truncate text-[15px] font-bold">
          {title}
        </h2>
        {meta}
      </div>
      <PlaybackButtons variant="icon" onPlay={onPlay} onShuffle={onShuffle} shuffleMenu={shuffleMenu} extra={extra} />
    </div>
  </div>
);
