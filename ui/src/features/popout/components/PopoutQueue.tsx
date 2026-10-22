import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WatchTrack } from "@/lib/api";
import { cn } from "@/util/cn";
import { largestCover } from "@/features/player/lib/coverAccent";

const ROW_HEIGHT = 48;

/**
 * The queue tab, sized for a 380px window.
 *
 * One button per row, so the highlight covers the duration too, and the whole
 * row is the hit area. Right-click opens the row menu, as a track row does
 * elsewhere in the app. No group labels: the now-playing row already stands
 * out, and three bands of headings in a 300px list is noise.
 */
export const PopoutQueue = ({
  queue,
  index,
  onPlay,
  onMenu,
}: {
  queue: WatchTrack[];
  /** Index of the playing song, or -1. */
  index: number;
  onPlay: (index: number) => void;
  onMenu: (track: WatchTrack, x: number, y: number) => void;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: queue.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (row) => `${queue[row]?.videoId || "track"}-${row}`,
  });

  if (queue.length === 0) {
    return (
      <p className="px-8 py-10 text-center text-xs leading-5 text-primary-dark">
        Nothing queued. Play a song and its queue lands here.
      </p>
    );
  }

  return (
    <div ref={listRef} className="scrollbar-thin h-full overflow-y-auto px-2 pb-2 pt-1">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const track = queue[row.index];
          if (!track) return null;
          const playing = row.index === index;
          const cover = largestCover(track);
          return (
            <button
              key={row.key}
              type="button"
              onClick={() => onPlay(row.index)}
              onContextMenu={(event) => {
                event.preventDefault();
                onMenu(track, event.clientX, event.clientY);
              }}
              className={cn(
                "absolute inset-x-0 top-0 flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 text-left transition-colors hover:bg-white/[0.06]",
                playing && "bg-white/[0.08]",
              )}
              style={{ height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}
            >
              <span className="relative size-8 shrink-0">
                {cover ? (
                  <img src={cover} alt="" className="size-8 rounded-md object-cover" />
                ) : (
                  <span className="grid size-8 place-items-center rounded-md bg-white/[0.06]">
                    <span className="icon-[solar--music-note-linear] text-sm text-primary-dark" />
                  </span>
                )}
                {playing && (
                  <span className="absolute inset-0 grid place-items-center rounded-md bg-black/55">
                    <span className="icon-[solar--pause-bold] text-xs text-white" />
                  </span>
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] leading-4 text-primary">{track.title}</span>
                <span className="mt-0.5 block truncate text-[11px] leading-4 text-primary-dark">
                  {track.artists?.map((artist) => artist.name).filter(Boolean).join(", ")}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-primary-dark">{track.length ?? ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
