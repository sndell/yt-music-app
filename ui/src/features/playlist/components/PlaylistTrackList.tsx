import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";

const TRACK_HEIGHT = 56; // Height of each track item in pixels

export const PlaylistTrackList = ({ tracks, gradient }: { tracks: Track[]; gradient: string }) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current?.closest(".scrollbar") as HTMLElement | null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 16,
  });

  return (
    <div ref={parentRef} className="flex relative flex-col gap-3 p-4 sm:p-6">
      <div className="absolute top-0 right-0 left-0 h-64 pointer-events-none" style={{ background: gradient }} />
      <div className="grid grid-cols-[5fr_1fr] md:grid-cols-[7fr_5fr_1fr] border-b border-primary pb-1.5 text-sm text-primary-dark">
        <div>Track</div>
        <div className="max-md:hidden">Album</div>
        <div className="justify-self-end">Duration</div>
      </div>
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const track = tracks[virtualItem.index];
          return (
            <div
              key={track.videoId}
              className="absolute left-0 w-full"
              style={{
                height: TRACK_HEIGHT,
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <PlaylistTrackItem track={track} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const PlaylistTrackItem = ({ track }: { track: Track }) => {
  const { setCurrentSong } = usePlayer();

  const handleClick = () => {
    setCurrentSong(track);
  };

  return (
    <button
      onClick={handleClick}
      className={cn(
        "grid gap-4 py-1.5 px-1 items-center grid-cols-[5fr_1fr] md:grid-cols-[7fr_5fr_1fr] cursor-pointer hover:bg-primary-light transition-colors rounded-lg w-full h-full",
        track.isAvailable ? "opacity-100" : "opacity-25"
      )}
    >
      <div className="flex gap-3 items-center min-w-0">
        <div className="flex overflow-hidden justify-center items-center w-10 h-10 rounded-md sm:w-12 sm:h-12 shrink-0 bg-primary-light">
          {track.thumbnails[0].url ? (
            <img src={track.thumbnails[0].url} alt={track.title} className="object-cover" />
          ) : (
            <div className="grid place-items-center w-full h-full bg-primary-light">
              <span className="icon-[mingcute--music-2-line] text-primary-dark" />
            </div>
          )}
        </div>
        <div className="flex overflow-hidden flex-col items-start min-w-0 text-start">
          <span className="w-full font-medium truncate">{track.title}</span>
          <span className="w-full text-sm truncate text-primary-dark">
            {track.artists.map((a) => a.name).join(", ")}
          </span>
        </div>
      </div>
      <div className="flex min-w-0 text-start max-md:hidden text-primary-dark">
        <span className="w-full truncate">{track.album?.name ?? "Unknown Album"}</span>
      </div>
      <div className="justify-self-end text-sm text-primary-dark shrink-0">{track.duration}</div>
    </button>
  );
};
