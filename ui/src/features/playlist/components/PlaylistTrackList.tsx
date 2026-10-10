import { useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LikeStatus, Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { TrackMenu } from "@/components/ui/TrackMenu";

const TRACK_HEIGHT = 56; // Height of each track item in pixels

export const PlaylistTrackList = ({
  tracks,
  gradient,
  playlistId,
}: {
  tracks: Track[];
  gradient: string;
  playlistId: string | undefined;
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const { playTrackNext, addTrackToQueue, startMix } = usePlayer();

  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => parentRef.current?.closest(".scrollbar") as HTMLElement | null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 16,
  });

  return (
    <div ref={parentRef} className="relative flex flex-col gap-3 py-4 sm:py-6">
      <div className="pointer-events-none absolute top-0 right-0 left-0 h-64" style={{ background: gradient }} />
      <div className="px-4 sm:px-6">
        <div className="grid grid-cols-[5fr_1fr] border-b border-primary pb-1.5 text-sm text-primary-dark md:grid-cols-[7fr_5fr_1fr]">
          <div>Track</div>
          <div className="max-md:hidden">Album</div>
          <div className="justify-self-end">Duration</div>
        </div>
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
              <PlaylistTrackItem
                track={track}
                playlistId={playlistId}
                onOpenMenu={(x, y) => setMenu({ track, x, y })}
              />
            </div>
          );
        })}
      </div>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
        />
      )}
    </div>
  );
};

const ratingButtonClass = (active: boolean) =>
  cn(
    "grid size-8 cursor-pointer place-items-center rounded-full text-lg transition-colors",
    active ? "text-primary" : "text-primary-dark hover:bg-secondary hover:text-primary"
  );

const PlaylistTrackItem = ({
  track,
  playlistId,
  onOpenMenu,
}: {
  track: Track;
  playlistId?: string;
  onOpenMenu: (x: number, y: number) => void;
}) => {
  const { playFromPlaylist, rateTrack } = usePlayer();
  const likeStatus = track.likeStatus ?? "INDIFFERENT";

  const handleClick = () => {
    playFromPlaylist(track, playlistId);
  };

  const handleRate = (rating: LikeStatus) => {
    void rateTrack(track.videoId, likeStatus, rating);
  };

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (!track.isAvailable || !track.videoId) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
      className={cn(
        "group relative h-full w-full transition-colors hover:bg-primary-light",
        track.isAvailable ? "opacity-100" : "opacity-25"
      )}
    >
      <button
        type="button"
        onClick={handleClick}
        aria-label={`Play ${track.title}`}
        className="absolute inset-0 z-0 cursor-pointer"
      />
      <div className="pointer-events-none relative z-0 grid h-full grid-cols-[5fr_1fr] items-center gap-4 px-5 py-1.5 md:grid-cols-[7fr_5fr_1fr] sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary-light sm:h-12 sm:w-12">
            {track.thumbnails[0]?.url ? (
              <img src={track.thumbnails[0].url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="grid h-full w-full place-items-center bg-primary-light">
                <span className="icon-[solar--music-note-linear] text-primary-dark" />
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col items-start overflow-hidden text-start">
            <span className="w-full truncate font-medium">{track.title}</span>
            <span className="w-full truncate text-sm text-primary-dark">
              {track.artists.map((artist) => artist.name).join(", ")}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 text-start text-primary-dark max-md:hidden">
          <span className="w-full truncate">{track.album?.name ?? "Unknown Album"}</span>
        </div>
        <div className="shrink-0 justify-self-end text-sm text-primary-dark transition-opacity duration-200 group-hover:opacity-0">
          {track.duration}
        </div>
      </div>
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 right-4 z-10 flex translate-x-4 items-center gap-0.5 bg-linear-to-l from-primary-light from-60% to-transparent pr-1 pl-10 opacity-0 transition-[opacity,translate] duration-200 ease-out sm:right-6",
          "group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100",
          "focus-within:pointer-events-auto focus-within:translate-x-0 focus-within:opacity-100"
        )}
      >
        <button
          type="button"
          aria-label="Like"
          aria-pressed={likeStatus === "LIKE"}
          onClick={() => handleRate("LIKE")}
          className={ratingButtonClass(likeStatus === "LIKE")}
        >
          <span className={likeStatus === "LIKE" ? "icon-[solar--like-bold]" : "icon-[solar--like-linear]"} />
        </button>
        <button
          type="button"
          aria-label="Dislike"
          aria-pressed={likeStatus === "DISLIKE"}
          onClick={() => handleRate("DISLIKE")}
          className={ratingButtonClass(likeStatus === "DISLIKE")}
        >
          <span className={likeStatus === "DISLIKE" ? "icon-[solar--dislike-bold]" : "icon-[solar--dislike-linear]"} />
        </button>
      </div>
    </div>
  );
};
