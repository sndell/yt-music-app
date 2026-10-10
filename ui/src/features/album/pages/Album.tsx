import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import type { AlbumDetails, LikeStatus } from "@/lib/api";
import type { Artist } from "@/lib/api/types";
import { PyBridge } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { PlaylistDescription } from "@/features/playlist/components/PlaylistDescription";
import { PlaylistTrackList } from "@/features/playlist/components/PlaylistTrackList";
import { BrowseCard, BrowseRow } from "@/components/ui/BrowseCard";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";

const titleClass = "line-clamp-2 pt-1.5 text-3xl font-bold wrap-break-word @2xl:text-5xl";
const headerLayoutClass = "flex flex-col gap-4 p-6 @lg:flex-row @lg:items-start @lg:gap-6";
const coverSizeClass = "size-40 shrink-0 @2xl:size-48";
const actionClass =
  "flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-primary px-3 py-1.5 text-sm transition-colors hover:bg-primary-light";
const iconButtonClass =
  "grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-primary transition-colors hover:bg-primary-light";

const withRatings = (album: AlbumDetails, ratings: Record<string, LikeStatus>): AlbumDetails => {
  let changed = false;
  const tracks = album.tracks.map((track) => {
    const status = ratings[track.videoId];
    if (!status || status === track.likeStatus) return track;
    changed = true;
    return { ...track, likeStatus: status };
  });
  return changed ? { ...album, tracks } : album;
};

const ArtistLinks = ({ artists }: { artists: Artist[] }) => (
  <span className="inline-flex max-w-full min-w-0 flex-wrap items-baseline text-primary">
    {artists.map((artist, index) => (
      <span key={`${artist.id}-${artist.name}-${index}`} className="inline-flex max-w-full min-w-0 items-baseline">
        {index > 0 && <span className="whitespace-pre">, </span>}
        {artist.id ? (
          <Link
            href={`/artist/${artist.id}`}
            onClick={(event) => event.stopPropagation()}
            className="truncate hover:underline"
          >
            {artist.name}
          </Link>
        ) : (
          <span className="truncate">{artist.name}</span>
        )}
      </span>
    ))}
  </span>
);

const MetaLine = ({ parts, className }: { parts: (ReactNode | string | null | undefined | false)[]; className?: string }) => {
  const visible = parts.filter((part) => part != null && part !== false && part !== "");
  if (visible.length === 0) return null;

  return (
    <p className={cn("flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 font-medium text-primary-dark", className)}>
      {visible.map((part, index) => (
        <span key={index} className="inline-flex min-w-0 items-center gap-1.5">
          {index > 0 && (
            <span className="text-sm leading-none" aria-hidden="true">
              •
            </span>
          )}
          {part}
        </span>
      ))}
    </p>
  );
};

const Cover = ({
  url,
  alt,
  className,
  iconClass = "text-4xl",
}: {
  url?: string;
  alt: string;
  className: string;
  iconClass?: string;
}) => {
  const [failed, setFailed] = useState(false);

  if (url && !failed) {
    return (
      <img
        src={url}
        alt={alt}
        onError={() => setFailed(true)}
        className={cn(className, "object-cover")}
      />
    );
  }

  return (
    <div className={cn(className, "grid place-items-center bg-primary-light")}>
      <span className={cn("icon-[solar--music-note-linear] text-primary-dark", iconClass)} />
    </div>
  );
};

const PageFallback = ({ error, onReload }: { error: string | null; onReload: () => void }) => {
  if (error) {
    return (
      <div className="grid h-full place-items-center px-6 py-8">
        <div className="text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button type="button" onClick={onReload} className="mt-3 cursor-pointer text-sm text-primary hover:underline">
            Reload
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full place-items-center py-8" role="status">
      <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
    </div>
  );
};

export const Album = () => {
  const { id } = useParams();
  const { playPlaylist, trackRatings } = usePlayer();
  const [album, setAlbum] = useState<AlbumDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState(id);
  const [attempt, setAttempt] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  if (id !== loadedId) {
    setLoadedId(id);
    setAlbum(null);
    setError(null);
    setIsScrolled(false);
  }

  useEffect(() => {
    if (!id) return;
    let active = true;
    PyBridge.getAlbum(id).then((result) => {
      if (!active) return;
      if (result.success) {
        setAlbum(result.data);
        setError(null);
        return;
      }
      setAlbum(null);
      setError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [id, attempt]);

  const albumReadyId = album?.title && loadedId === id ? id : null;
  useLayoutEffect(() => {
    if (!albumReadyId) return;
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    // A scroll event from the page being left can open the compact header after the route change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsScrolled(false);
  }, [albumReadyId]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    const header = headerRef.current;
    if (!container || !header || !container.isConnected) return;
    const headerHeight = header.offsetHeight;
    if (headerHeight <= 0) return;
    setIsScrolled(container.scrollTop > headerHeight * 0.75);
  };

  const reload = () => {
    setAlbum(null);
    setError(null);
    setAttempt((value) => value + 1);
  };

  const rated = album ? withRatings(album, trackRatings) : null;

  if (!rated?.title) {
    return <PageFallback error={error} onReload={reload} />;
  }

  const { title, description, thumbnails, artists, year, trackCount, type, dominantColor, audioPlaylistId } = rated;
  const thumbnailUrl = thumbnails?.[0]?.url;
  const versions = rated.otherVersions.filter((version) => version.browseId);

  const play = (mode: "play" | "shuffle") => {
    if (!audioPlaylistId) return;
    void playPlaylist(audioPlaylistId, mode);
  };

  const detailsGradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 1)}, ${hexToRgba(dominantColor, 0.2)})`
    : "transparent";

  const tracksGradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 0.1)}, #0000)`
    : "transparent";

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 0.4) : "black";

  const meta = (className?: string) => (
    <MetaLine
      className={className}
      parts={[
        type ? <span className="capitalize">{type}</span> : null,
        year,
        artists.length > 0 ? <ArtistLinks artists={artists} /> : null,
        `${trackCount} songs`,
      ]}
    />
  );

  const playback = audioPlaylistId ? (
    <div className="flex items-center gap-2 pt-4">
      <button type="button" onClick={() => play("play")} className={actionClass}>
        <span className="icon-[solar--play-bold] text-base" />
        Play
      </button>
      <button type="button" onClick={() => play("shuffle")} className={actionClass}>
        <span className="icon-[solar--shuffle-linear] text-base" />
        Shuffle
      </button>
    </div>
  ) : null;

  return (
    <div className="@container relative flex flex-1 flex-col overflow-hidden">
      <div
        className="absolute top-0 right-0 left-0 z-10 transition-transform duration-300"
        style={{
          transform: isScrolled ? "translateY(0)" : "translateY(-100%)",
          opacity: isScrolled ? 1 : 0,
        }}
      >
        <div className="flex gap-3 items-center p-3 w-full backdrop-blur-2xl" style={{ background: stickyBg }}>
          <Cover key={thumbnailUrl ?? "empty"} url={thumbnailUrl} alt={title} className="size-12 rounded shadow-md" iconClass="text-lg" />
          <div className="min-w-0 flex-1">
            <h2 title={title} className="truncate text-xl font-bold">
              {title}
            </h2>
            {meta("text-sm leading-5")}
          </div>
          {audioPlaylistId && (
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" aria-label="Play" onClick={() => play("play")} className={iconButtonClass}>
                <span className="icon-[solar--play-bold]" />
              </button>
              <button type="button" aria-label="Shuffle" onClick={() => play("shuffle")} className={iconButtonClass}>
                <span className="icon-[solar--shuffle-linear]" />
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        key={id}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="overflow-y-auto flex-1 scrollbar [overflow-anchor:none]"
      >
        <div ref={headerRef} className={headerLayoutClass} style={{ background: detailsGradient }}>
          <Cover
            key={thumbnailUrl ?? "cover"}
            url={thumbnailUrl}
            alt={title}
            className={cn(coverSizeClass, "rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]")}
          />
          <div className="min-w-0 flex-1 text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)] @lg:self-end">
            <h1 title={title} className={titleClass}>
              {title}
            </h1>
            <PlaylistDescription description={description} />
            {meta("pt-3")}
            {playback}
          </div>
        </div>

        <PlaylistTrackList tracks={rated.tracks} gradient={tracksGradient} playlistId={audioPlaylistId ?? undefined} />

        {versions.length > 0 && (
          <BrowseRow title="Other versions">
            {versions.map((version, index) => (
              <BrowseCard
                key={`${version.browseId}-${index}`}
                href={`/album/${version.browseId}`}
                title={version.title}
                subtitle={version.year}
                explicit={version.explicit}
                thumbnails={version.thumbnails}
              />
            ))}
          </BrowseRow>
        )}
      </div>
    </div>
  );
};
