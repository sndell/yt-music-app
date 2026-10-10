import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import type { LikeStatus, PlaylistDetails, PlaylistSummary } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { hexToRgba } from "@/util/hex_to_rgba";
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

const PlaylistTracksLoading = ({ summary }: { summary: PlaylistSummary }) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = summary.thumbnails?.[0]?.url;

  return (
    <div className="grid h-full place-items-center py-8">
      <div className="flex w-56 flex-col items-center">
        <div className="flex max-w-full items-center gap-2">
          {thumbnailUrl && !failed ? (
            <img
              src={thumbnailUrl}
              alt=""
              onError={() => setFailed(true)}
              className="size-10 shrink-0 rounded-sm object-cover"
            />
          ) : (
            <div className="grid size-10 shrink-0 place-items-center rounded-sm bg-primary-light">
              <span className="icon-[solar--music-note-linear] text-primary-dark" />
            </div>
          )}
          <span className="truncate text-sm">{summary.title}</span>
        </div>
        <div className="my-4 w-full border-t border-primary" />
        <div className="flex items-center gap-2 text-primary-dark" role="status">
          <span className="icon-[solar--loader-linear] animate-spin text-2xl" />
          <span className="text-sm">Loading tracks</span>
        </div>
      </div>
    </div>
  );
};

export const Playlist = () => {
  const { id } = useParams();
  const { playlists, fetchPlaylistItems } = usePlaylist();
  const { trackRatings } = usePlayer();
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

  return (
    <div className="flex overflow-hidden relative flex-col flex-1">
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
          <div>
            <h2 className="text-xl font-bold truncate">{title}</h2>
            <p className="font-medium text-primary-dark">
              <span className="text-primary">{author.name} </span>
              <span className="capitalize">
                <span className="text-sm">•</span> {year} <span className="text-sm">•</span> {trackCount} songs{" "}
                <span className="text-sm">•</span> {privacy.toLowerCase()}
              </span>
            </p>
          </div>
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
          className="flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:gap-6"
          style={{ background: detailsGradient }}
        >
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={title}
              className="size-40 shrink-0 rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)] sm:size-48"
            />
          )}
          {/* Stays on the cover's bottom edge while the description height eases, so hiding it doesn't snap the text down. */}
          <div className="min-w-0 flex-1 text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)] sm:self-end">
            <h1 className="pt-1.5 text-3xl font-bold wrap-anywhere sm:text-5xl">{title}</h1>
            <PlaylistDescription description={description} />
            <p className="pt-3 font-medium text-primary-dark">
              <span className="text-primary">{author.name} </span>
              <span className="capitalize">
                <span className="text-sm">•</span> {year} <span className="text-sm">•</span> {trackCount} songs{" "}
                <span className="text-sm">•</span> {privacy.toLowerCase()}
              </span>
            </p>
          </div>
        </div>

        {/* Track list */}
        <PlaylistTrackList tracks={playlist.tracks} gradient={tracksGradient} playlistId={id} />
      </div>
    </div>
  );
};
