import { useState } from "react";
import { PyBridge, type Track } from "@/lib/api";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { isVideoMedia } from "@/components/ui/mediaFrame";
import { cn } from "@/util/cn";

/**
 * One compact library song row. The Songs view renders the full list
 * virtualized; this is the short preview the All view shows, so it stays a
 * plain button instead of a track-list row.
 */
export const LibraryTrackRow = ({
  track,
  playing = false,
  onPlay,
}: {
  track: Track;
  playing?: boolean;
  onPlay: () => void;
}) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const thumbnailUrl = track.thumbnails[0]?.url;
  const inlinedUrl = inlined?.from === thumbnailUrl ? inlined.url : null;
  const coverSrc = inlinedUrl ?? thumbnailUrl;
  const showCover = Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl;
  const available = track.isAvailable && Boolean(track.videoId);
  const subtitle = track.artists.map((artist) => artist.name).join(", ");

  const handleCoverError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((result) => {
      if (result.success && typeof result.data === "string" && result.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: result.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={!available}
      aria-label={`Play ${track.title}`}
      className={cn(
        "group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-primary-light disabled:cursor-default",
        playing && "bg-primary-light",
      )}
    >
      <span
        className={cn(
          "relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-secondary",
          isVideoMedia(track.videoType) ? "h-10 aspect-video" : "size-10",
        )}
      >
        {showCover && coverSrc ? (
          <img
            src={coverSrc}
            alt=""
            draggable={false}
            onError={handleCoverError}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        )}
        {available && (
          <span className={mediaScrimClass}>
            <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-medium text-primary">{track.title}</span>
          {track.isExplicit && <ExplicitBadge />}
        </span>
        {subtitle && <span className="block truncate text-xs text-primary-dark">{subtitle}</span>}
      </span>
      {track.duration && <span className="shrink-0 text-xs text-primary-dark tabular-nums">{track.duration}</span>}
    </button>
  );
};
