import { useState } from "react";
import { PyBridge, type SearchResult } from "@/lib/api";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { isVideoMedia } from "@/components/ui/mediaFrame";
import { cn } from "@/util/cn";

const kindIcon = (kind: SearchResult["kind"]) => {
  if (kind === "artist" || kind === "profile") return "icon-[solar--user-linear]";
  if (kind === "album" || kind === "playlist") return "icon-[solar--music-note-linear]";
  return "icon-[solar--music-note-linear]";
};

const isRound = (kind: SearchResult["kind"]) => kind === "artist" || kind === "profile";

/** One compact search result row, shared by the sidebar flyout and the search page. */
export const SearchRow = ({
  result,
  onSelect,
  onOpenMenu,
  dense = false,
}: {
  result: SearchResult;
  onSelect: () => void;
  onOpenMenu?: (x: number, y: number) => void;
  dense?: boolean;
}) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const thumbnailUrl = result.thumbnails[0]?.url;
  const inlinedUrl = inlined?.from === thumbnailUrl ? inlined.url : null;
  const coverSrc = inlinedUrl ?? thumbnailUrl;
  const showCover = Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl;

  const handleCoverError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((bridge) => {
      if (bridge.success && typeof bridge.data === "string" && bridge.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: bridge.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      onContextMenu={
        onOpenMenu
          ? (event) => {
              event.preventDefault();
              onOpenMenu(event.clientX, event.clientY);
            }
          : undefined
      }
      className={cn(
        "group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-primary-light",
        dense ? "py-1.5" : "py-2",
      )}
    >
      <span
        className={cn(
          "relative grid shrink-0 place-items-center overflow-hidden bg-secondary",
          isVideoMedia(result.videoType) ? (dense ? "h-9 aspect-video" : "h-10 aspect-video") : dense ? "size-9" : "size-10",
          isRound(result.kind) ? "rounded-full" : "rounded-md",
        )}
      >
        {showCover && coverSrc ? (
          <img src={coverSrc} alt="" draggable={false} onError={handleCoverError} className="h-full w-full object-cover" />
        ) : (
          <span className={cn("text-primary-dark", kindIcon(result.kind))} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm font-medium text-primary">{result.title}</span>
          {result.explicit && <ExplicitBadge />}
        </span>
        {result.subtitle && <span className="block truncate text-xs text-primary-dark">{result.subtitle}</span>}
      </span>
      {result.duration && (
        <span className="shrink-0 text-xs text-primary-dark tabular-nums">{result.duration}</span>
      )}
    </button>
  );
};
