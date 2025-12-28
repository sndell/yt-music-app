import { useLayoutEffect, useRef, useState } from "react";
import { useParams } from "wouter";
import type { PlaylistDetails } from "@/lib/api";
import { hexToRgba } from "@/util/hex_to_rgba";
import { usePlaylist } from "../hooks/usePlaylist";
import { PlaylistTrackList } from "../components/PlaylistTrackList";

export const Playlist = () => {
  const { id } = useParams();
  const { fetchPlaylistItems } = usePlaylist();
  const [playlist, setPlaylist] = useState<PlaylistDetails | null>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!id) return;
    fetchPlaylistItems(id).then((data) => data && setPlaylist(data));
  }, [id, fetchPlaylistItems]);

  const handleScroll = () => {
    if (!scrollContainerRef.current || !headerRef.current) return;
    const scrollTop = scrollContainerRef.current.scrollTop;
    const headerHeight = headerRef.current.offsetHeight;
    // Trigger sticky header after scrolling past ~60% of original header
    setIsScrolled(scrollTop > headerHeight * 0.6);
  };

  if (!playlist) {
    return (
      <div className="grid place-items-center py-8 h-full">
        <span className="icon-[svg-spinners--ring-resize] text-2xl text-primary-dark" />
      </div>
    );
  }

  const { title, description, thumbnails, author, year, trackCount, privacy, dominantColor } = playlist;
  const thumbnailUrl = thumbnails[0]?.url;

  const gradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 1)}, ${hexToRgba(dominantColor, 0.2)})`
    : undefined;

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 1) : "var(--background-color-primary)";

  return (
    <div className="flex overflow-hidden relative flex-col flex-1">
      {/* Sticky compact header - appears when scrolled */}
      <div
        className="absolute top-0 right-0 left-0 z-10 flex gap-4 items-center px-6 py-3 transition-all duration-300"
        style={{
          background: stickyBg,
          transform: isScrolled ? "translateY(0)" : "translateY(-100%)",
          opacity: isScrolled ? 1 : 0,
        }}
      >
        {thumbnailUrl && <img src={thumbnailUrl} alt={title} className="size-12 shrink-0 rounded shadow-md" />}
        <h2 className="text-xl font-bold truncate">{title}</h2>
      </div>

      {/* Scrollable content */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="overflow-y-auto flex-1 scrollbar">
        {/* Original full header */}
        <div ref={headerRef} className="flex gap-6 items-end p-6" style={{ background: gradient }}>
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={title}
              className="size-48 shrink-0 rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]"
            />
          )}
          <div className="text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)]">
            <h1 className="pt-1.5 text-5xl font-bold">{title}</h1>
            <p className="pt-1.5 font-medium text-primary-dark opacity-90">{description ?? "No description"}</p>
            <p className="pt-3 font-medium text-primary-dark">
              <span className="text-primary">{author.name}</span>
              <span className="capitalize">
                {" "}
                • {year} • {trackCount} songs • {privacy.toLowerCase()}
              </span>
            </p>
          </div>
        </div>

        {/* Track list */}
        <PlaylistTrackList tracks={playlist.tracks} />
      </div>
    </div>
  );
};
