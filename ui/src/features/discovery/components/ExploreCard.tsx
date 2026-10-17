import type { ExploreItem } from "@/lib/api/types";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { useInlineThumbnail } from "@/components/ui/useInlineThumbnail";
import { cn } from "@/util/cn";

/**
 * The glyph a card shows over its cover. A song and a video play; a release,
 * playlist and artist open a page, so the icon says which the click does.
 */
const ICONS: Record<ExploreItem["kind"], string> = {
  song: "icon-[solar--play-bold]",
  video: "icon-[solar--videocamera-record-bold]",
  album: "icon-[solar--album-linear]",
  playlist: "icon-[solar--playlist-linear]",
  artist: "icon-[solar--user-linear]",
};

const LABELS: Record<ExploreItem["kind"], string> = {
  song: "Play",
  video: "Play",
  album: "Open",
  playlist: "Open",
  artist: "Open",
};

/**
 * One Explore card. Square art for every kind, the same frame the browse cards
 * use: the 16:9 video frame is Home's alone, and a new-video row reads as a
 * video through its glyph and its views, not through its frame.
 */
export const ExploreCard = ({
  item,
  playing = false,
  onActivate,
}: {
  item: ExploreItem;
  playing?: boolean;
  onActivate: () => void;
}) => {
  const { coverSrc, showCover, onError } = useInlineThumbnail(item.thumbnails?.[0]?.url);
  const detail = item.subtitle.trim();

  return (
    <button
      type="button"
      onClick={onActivate}
      aria-label={`${LABELS[item.kind]} ${item.title}`}
      className="group w-36 shrink-0 cursor-pointer text-left sm:w-40"
    >
      <span
        className={cn(
          "relative block aspect-square overflow-hidden rounded-md bg-secondary",
          playing && "ring-2 ring-accent",
        )}
      >
        {showCover && coverSrc ? (
          <img
            src={coverSrc}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={onError}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
          </span>
        )}
        <span className={mediaScrimClass}>
          <RevealIcon iconClassName={cn(ICONS[item.kind], "text-2xl")} />
        </span>
      </span>
      <span className="mt-2 block w-full">
        <span className="block truncate text-sm font-medium">{item.title}</span>
        {(detail || item.explicit) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
            {item.explicit && <ExplicitBadge />}
            {detail && <span className="truncate">{detail}</span>}
          </span>
        )}
      </span>
    </button>
  );
};
