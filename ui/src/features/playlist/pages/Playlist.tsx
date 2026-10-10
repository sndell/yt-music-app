import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import type { LikeStatus, PlaylistDetails, PlaylistSummary } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";
import { PlaybackButtons } from "@/components/ui/PlaybackButtons";
import { usePlaylist } from "../hooks/usePlaylist.tsx";
import { PlaylistDescription } from "../components/PlaylistDescription";
import { PlaylistTrackList } from "../components/PlaylistTrackList";

const withRatings = (playlist: PlaylistDetails, ratings: Record<string, LikeStatus>): PlaylistDetails => {
  let changed = false;
  const tracks = playlist.tracks.map((track) => {
    const status = ratings[track.videoId];
    if (!status || status === track.likeStatus) return track;
    changed = true;
    return { ...track, likeStatus: status };
  });
  return changed ? { ...playlist, tracks } : playlist;
};

const playlistTitleClass = "line-clamp-2 pt-1.5 text-3xl font-bold wrap-break-word @2xl:text-5xl";
const headerLayoutClass = "flex flex-col gap-4 p-6 @lg:flex-row @lg:items-start @lg:gap-6";
const coverSizeClass = "size-40 shrink-0 @2xl:size-48";

const PlaylistMeta = ({
  author,
  year,
  trackCount,
  privacy,
  className,
}: {
  author: string;
  year: string;
  trackCount: number;
  privacy: string;
  className?: string;
}) => {
  const details = [year, `${trackCount} songs`, privacy.toLowerCase()].filter(Boolean);

  return (
    <p className={cn("flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 font-medium text-primary-dark", className)}>
      <span className="w-max max-w-full shrink-0 text-primary wrap-break-word">{author}</span>
      {details.map((detail) => (
        <span key={detail} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap capitalize">
          <span className="text-sm leading-none" aria-hidden="true">
            •
          </span>
          {detail}
        </span>
      ))}
    </p>
  );
};

const SKELETON_ROWS = [
  { title: "w-40", artist: "w-24", album: "w-28" },
  { title: "w-56", artist: "w-20", album: "w-36" },
  { title: "w-32", artist: "w-28", album: "w-24" },
  { title: "w-48", artist: "w-16", album: "w-32" },
  { title: "w-36", artist: "w-24", album: "w-20" },
  { title: "w-44", artist: "w-20", album: "w-28" },
] as const;

const PlaylistTracksLoading = ({ summary }: { summary: PlaylistSummary }) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = summary.thumbnails?.[0]?.url;

  return (
    <div className="@container flex flex-1 flex-col overflow-hidden">
      <div className={headerLayoutClass}>
        {thumbnailUrl && !failed ? (
          <img
            src={thumbnailUrl}
            alt=""
            onError={() => setFailed(true)}
            className={cn(coverSizeClass, "rounded-md object-cover shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]")}
          />
        ) : (
          <div className={cn(coverSizeClass, "grid place-items-center rounded-md bg-primary-light")}>
            <span className="icon-[solar--music-note-linear] text-4xl text-primary-dark" />
          </div>
        )}
        <div className="min-w-0 flex-1 @lg:self-end">
          <h1 title={summary.title} className={playlistTitleClass}>
            {summary.title}
          </h1>
          <p className="flex items-center gap-2 pt-3 text-sm text-primary-dark" role="status">
            <span className="icon-[solar--loader-linear] animate-spin text-base" />
            Loading tracks
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col py-4 sm:py-6">
        <div className="px-4 sm:px-6">
          <div className="grid grid-cols-[5fr_1fr] border-b border-primary pb-1.5 text-sm text-primary-dark md:grid-cols-[7fr_5fr_1fr]">
            <div>Track</div>
            <div className="max-md:hidden">Album</div>
            <div className="justify-self-end">Duration</div>
          </div>
        </div>
        <div className="relative mt-1 min-h-0 flex-1 overflow-hidden">
          {Array.from({ length: 14 }, (_, index) => {
            const row = SKELETON_ROWS[index % SKELETON_ROWS.length];
            return (
              <div
                key={index}
                className="grid h-14 grid-cols-[5fr_1fr] items-center gap-4 px-5 sm:px-7 md:grid-cols-[7fr_5fr_1fr]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="size-10 shrink-0 rounded-md bg-secondary sm:size-12" />
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className={`h-3 rounded-full bg-secondary ${row.title}`} />
                    <div className={`h-2.5 rounded-full bg-secondary/70 ${row.artist}`} />
                  </div>
                </div>
                <div className={`hidden h-2.5 rounded-full bg-secondary/70 md:block ${row.album}`} />
                <div className="h-2.5 w-8 justify-self-end rounded-full bg-secondary/70" />
              </div>
            );
          })}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-primary to-transparent" />
        </div>
      </div>
    </div>
  );
};

export const Playlist = () => {
  const { id } = useParams();
  const { playlists, fetchPlaylistItems } = usePlaylist();
  const { playPlaylist, trackRatings } = usePlayer();
  const ratingsRef = useRef(trackRatings);
  ratingsRef.current = trackRatings;
  const [playlist, setPlaylist] = useState<PlaylistDetails | null>(null);
  const [loadedId, setLoadedId] = useState(id);
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  if (id !== loadedId) {
    setLoadedId(id);
    setPlaylist(null);
    setIsScrolled(false);
  }

  useEffect(() => {
    if (!id) return;
    let active = true;
    fetchPlaylistItems(id).then((data) => {
      if (active && data) setPlaylist(withRatings(data, ratingsRef.current));
    });
    return () => {
      active = false;
    };
  }, [id, fetchPlaylistItems]);

  useEffect(() => {
    setPlaylist((current) => (current ? withRatings(current, trackRatings) : current));
  }, [trackRatings]);

  // Leaving a scrolled playlist can emit a scroll event after the route change
  // clears this flag. The next playlist then paints with the compact header
  // already open, and a short list never scrolls again to close it.
  const playlistReadyId = playlist?.title && loadedId === id ? id : null;
  useLayoutEffect(() => {
    if (!playlistReadyId) return;
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    setIsScrolled(false);
  }, [playlistReadyId]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    const header = headerRef.current;
    if (!container || !header || !container.isConnected) return;
    const headerHeight = header.offsetHeight;
    if (headerHeight <= 0) return;
    setIsScrolled(container.scrollTop > headerHeight * 0.75);
  };

  if (!playlist?.title) {
    const summary = playlists.find((item) => item.playlistId === id);
    if (summary?.title) return <PlaylistTracksLoading summary={summary} />;

    return (
      <div className="grid place-items-center py-8 h-full">
        <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
      </div>
    );
  }

  const { title, description, thumbnails, author, year, trackCount, privacy, dominantColor } = playlist;
  const thumbnailUrl = thumbnails?.[0]?.url;

  const detailsGradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 1)}, ${hexToRgba(dominantColor, 0.2)})`
    : "transparent";

  const tracksGradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 0.1)}, #0000)`
    : "transparent";

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 0.4) : "black";

  const play = (mode: "play" | "shuffle") => {
    if (!id) return;
    void playPlaylist(id, mode);
  };

  return (
    <div className="@container relative flex flex-1 flex-col overflow-hidden">
      {/* Sticky compact header - appears when scrolled */}
      <div
        className="absolute top-0 right-0 left-0 z-10 transition-transform duration-300"
        style={{
          transform: isScrolled ? "translateY(0)" : "translateY(-100%)",
          opacity: isScrolled ? 1 : 0,
        }}
      >
        <div className="flex gap-3 items-center p-3 w-full backdrop-blur-2xl" style={{ background: stickyBg }}>
          {thumbnailUrl && <img src={thumbnailUrl} alt={title} className="rounded shadow-md size-12 shrink-0" />}
          <div className="min-w-0 flex-1">
            <h2 title={title} className="truncate text-xl font-bold">
              {title}
            </h2>
            <PlaylistMeta
              author={author.name}
              year={year}
              trackCount={trackCount}
              privacy={privacy}
              className="text-sm leading-5"
            />
          </div>
          <PlaybackButtons variant="icon" onPlay={() => play("play")} onShuffle={() => play("shuffle")} />
        </div>
        <div className="grid grid-cols-[5fr_1fr] md:grid-cols-[7fr_5fr_1fr] border-y border-primary bg-secondary/60 backdrop-blur-2xl py-1.5 px-6">
          <div>Track</div>
          <div className="max-md:hidden">Album</div>
          <div className="justify-self-end">Duration</div>
        </div>
      </div>

      {/* Scrollable content */}
      <div
        key={id}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="overflow-y-auto flex-1 scrollbar [overflow-anchor:none]"
      >
        {/* Original full header */}
        <div
          ref={headerRef}
          className={headerLayoutClass}
          style={{ background: detailsGradient }}
        >
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={title}
              className={cn(coverSizeClass, "rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]")}
            />
          )}
          {/* Stays on the cover's bottom edge while the description height eases, so hiding it doesn't snap the text down. */}
          <div className="min-w-0 flex-1 text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)] @lg:self-end">
            <h1 title={title} className={playlistTitleClass}>
              {title}
            </h1>
            <PlaylistDescription description={description} />
            <PlaylistMeta
              author={author.name}
              year={year}
              trackCount={trackCount}
              privacy={privacy}
              className="pt-3"
            />
            <PlaybackButtons className="pt-4" onPlay={() => play("play")} onShuffle={() => play("shuffle")} />
          </div>
        </div>

        {/* Track list */}
        <PlaylistTrackList tracks={playlist.tracks} gradient={tracksGradient} playlistId={id} />
      </div>
    </div>
  );
};
