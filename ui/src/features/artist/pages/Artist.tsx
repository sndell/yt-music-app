import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "wouter";
import type {
  ArtistDetails,
  ArtistRelease,
  ArtistShelf,
  ArtistVideo,
  LikeStatus,
  RelatedArtist,
  Track,
} from "@/lib/api";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { PlaylistDescription } from "@/features/playlist/components/PlaylistDescription";
import { PlaylistTrackList } from "@/features/playlist/components/PlaylistTrackList";
import { BrowseCard, BrowseRow } from "@/components/ui/BrowseCard";
import { PlaybackButtons } from "@/components/ui/PlaybackButtons";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";

const seeAllClass =
  "inline-flex shrink-0 cursor-pointer items-center gap-1.5 text-sm text-primary-dark hover:underline disabled:cursor-default disabled:opacity-40 disabled:hover:no-underline";

const RELEASES = [
  ["albums", "Albums"],
  ["singles", "Singles"],
  ["shows", "Shows"],
] as const;

type ReleaseKey = (typeof RELEASES)[number][0];

const mergeArtist = (current: ArtistDetails | null, incoming: ArtistDetails): ArtistDetails => {
  if (!current || current.channelId !== incoming.channelId) return incoming;
  const next = { ...incoming };
  for (const [key] of RELEASES) {
    const existing = current[key];
    const updated = incoming[key];
    if (existing && updated && existing.items.length > updated.items.length) next[key] = existing;
  }
  return next;
};

const labeled = (value: string | null, word: string, suffix: string) => {
  const text = value?.trim();
  if (!text) return null;
  if (text.toLowerCase().includes(word)) return text;
  return `${text} ${suffix}`;
};

const withSongRatings = (artist: ArtistDetails, ratings: Record<string, LikeStatus>): ArtistDetails => {
  if (!artist.songs) return artist;
  let changed = false;
  const items = artist.songs.items.map((track) => {
    const status = ratings[track.videoId];
    if (!status || status === track.likeStatus) return track;
    changed = true;
    return { ...track, likeStatus: status };
  });
  return changed ? { ...artist, songs: { ...artist.songs, items } } : artist;
};

const videoToTrack = (video: ArtistVideo, artist: ArtistDetails): Track => ({
  videoId: video.videoId,
  title: video.title,
  artists: artist.name ? [{ name: artist.name, id: artist.channelId }] : [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: video.thumbnails ?? [],
  isAvailable: Boolean(video.videoId),
  isExplicit: false,
  videoType: "MUSIC_VIDEO_TYPE_OMV",
  views: null,
  duration: "",
  durationSeconds: 0,
  setVideoId: "",
});

const filled = <T,>(shelf: ArtistShelf<T> | null): shelf is ArtistShelf<T> =>
  Boolean(shelf && shelf.items.length > 0);

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
    return <img src={url} alt={alt} onError={() => setFailed(true)} className={cn(className, "object-cover")} />;
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

const SeeAllButton = ({ loading, onClick }: { loading: boolean; onClick: () => void }) => (
  <button type="button" onClick={onClick} disabled={loading} aria-busy={loading} className={seeAllClass}>
    {loading && <span className="icon-[solar--loader-linear] animate-spin text-sm" />}
    See all
  </button>
);

const ReleaseShelfView = ({
  title,
  shelf,
  loading,
  error,
  expanded,
  onShowAll,
}: {
  title: string;
  shelf: ArtistShelf<ArtistRelease>;
  loading: boolean;
  error?: string;
  expanded: boolean;
  onShowAll: () => void;
}) => (
  <BrowseRow
    title={title}
    error={error}
    action={shelf.browseId && shelf.params && !expanded ? <SeeAllButton loading={loading} onClick={onShowAll} /> : null}
  >
    {shelf.items.map((release, index) =>
      release.browseId ? (
        <BrowseCard
          key={`${release.browseId}-${index}`}
          href={`/album/${release.browseId}`}
          title={release.title}
          subtitle={[release.type, release.year].filter(Boolean).join(" • ")}
          explicit={release.explicit}
          thumbnails={release.thumbnails}
        />
      ) : null
    )}
  </BrowseRow>
);

export const Artist = () => {
  const { id } = useParams();
  const { playPlaylist, playTracks, currentSong, trackRatings } = usePlayer();
  const pageIdRef = useRef(id);
  const [artist, setArtist] = useState<ArtistDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState(id);
  const [attempt, setAttempt] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const [expandedShelves, setExpandedShelves] = useState<Partial<Record<ReleaseKey, boolean>>>({});
  const [loadingShelves, setLoadingShelves] = useState<Partial<Record<ReleaseKey, boolean>>>({});
  const [shelfErrors, setShelfErrors] = useState<Partial<Record<ReleaseKey, string>>>({});
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  if (id !== loadedId) {
    setLoadedId(id);
    setArtist(null);
    setError(null);
    setIsScrolled(false);
    setExpandedShelves({});
    setLoadingShelves({});
    setShelfErrors({});
  }

  useEffect(() => {
    if (!id) return;
    let active = true;
    void showCachedThenRefresh(
      (forceRefresh) => PyBridge.getArtist(id, forceRefresh),
      (data) => {
        if (!data.name) return;
        setArtist((current) => mergeArtist(current, data));
        setError(null);
      },
      () => active,
    ).then((result) => {
      if (!active || !result || result.success) return;
      setArtist(null);
      setError(result.error.message);
    });
    return () => {
      active = false;
    };
  }, [id, attempt]);

  useLayoutEffect(() => {
    pageIdRef.current = id;
  }, [id]);

  const artistReadyId = artist?.name && loadedId === id ? id : null;
  useLayoutEffect(() => {
    if (!artistReadyId) return;
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
    // A scroll event from the page being left can open the compact header after the route change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsScrolled(false);
  }, [artistReadyId]);

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    const header = headerRef.current;
    if (!container || !header || !container.isConnected) return;
    const headerHeight = header.offsetHeight;
    if (headerHeight <= 0) return;
    setIsScrolled(container.scrollTop > headerHeight * 0.75);
  };

  const reload = () => {
    setArtist(null);
    setError(null);
    setAttempt((value) => value + 1);
  };

  const showAllReleases = (key: ReleaseKey, shelf: ArtistShelf<ArtistRelease>) => {
    if (!id || !shelf.browseId || !shelf.params) return;
    const pageId = id;
    setLoadingShelves((current) => ({ ...current, [key]: true }));
    setShelfErrors((current) => ({ ...current, [key]: undefined }));
    void PyBridge.getArtistAlbums(shelf.browseId, shelf.params).then((result) => {
      if (pageIdRef.current !== pageId) return;
      setLoadingShelves((current) => ({ ...current, [key]: false }));
      if (!result.success) {
        setShelfErrors((current) => ({ ...current, [key]: result.error.message }));
        return;
      }
      setExpandedShelves((current) => ({ ...current, [key]: true }));
      setArtist((current) => {
        const existing = current?.[key];
        if (!existing) return current;
        return { ...current, [key]: { ...existing, items: result.data } };
      });
    });
  };

  const rated = artist ? withSongRatings(artist, trackRatings) : null;

  if (!rated?.name) {
    return <PageFallback error={error} onReload={reload} />;
  }

  const { name, description, thumbnails, subscribers, monthlyListeners, dominantColor, shuffleId, radioId } = rated;
  const thumbnailUrl = thumbnails?.[0]?.url;
  const songs = filled(rated.songs) ? rated.songs : null;
  const videos = filled(rated.videos) ? rated.videos : null;
  const related = (rated.related ?? []).filter((item) => item.browseId);

  const playVideo = (index: number) => {
    if (!videos) return;
    playTracks(videos.items.slice(index).map((video) => videoToTrack(video, rated)));
  };

  const tracksGradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 0.1)}, #0000)`
    : "transparent";

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 0.4) : "black";

  const songsId = songs?.browseId;
  const onPlay = songsId ? () => void playPlaylist(songsId, "play") : undefined;
  const onShuffle = shuffleId ? () => void playPlaylist(shuffleId, "shuffle") : undefined;
  const radio = radioId
    ? {
        label: "Radio",
        iconClass: "icon-[solar--soundwave-linear]",
        onClick: () => void playPlaylist(radioId, "mix"),
      }
    : undefined;

  const meta = (className?: string) => (
    <MetaLine
      className={className}
      parts={[
        labeled(subscribers, "subscriber", "subscribers"),
        labeled(monthlyListeners, "monthly", "monthly listeners"),
      ]}
    />
  );

  const bio = description?.trim() ? description : null;

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
          <Cover key={thumbnailUrl ?? "empty"} url={thumbnailUrl} alt="" className="size-12 rounded shadow-md" iconClass="text-lg" />
          <div className="min-w-0 flex-1">
            <h2 title={name} className="truncate text-xl font-bold">
              {name}
            </h2>
            {meta("text-sm leading-5")}
          </div>
          <PlaybackButtons variant="icon" onPlay={onPlay} onShuffle={onShuffle} extra={radio} />
        </div>
      </div>

      <div key={id} ref={scrollContainerRef} onScroll={handleScroll} className="overflow-y-auto flex-1 scrollbar [overflow-anchor:none]">
        <div ref={headerRef} className="relative min-h-80 overflow-hidden @2xl:min-h-[28rem]">
          <Cover key={thumbnailUrl ?? "cover"} url={thumbnailUrl} alt="" className="absolute inset-0 size-full" />
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent from-30% via-black/55 via-70% to-black" />
          <div className="relative flex min-h-80 flex-col justify-end px-6 pt-24 pb-8 text-shadow-[0_2px_16px_rgba(0,0,0,0.55)] @2xl:min-h-[28rem]">
            <h1 title={name} className="line-clamp-2 text-3xl font-bold wrap-break-word @2xl:text-5xl">
              {name}
            </h1>
            {meta("pt-2 text-sm")}
            <PlaybackButtons className="pt-4" onPlay={onPlay} onShuffle={onShuffle} extra={radio} />
          </div>
        </div>

        {bio && (
          <div className="px-6 pb-8">
            <PlaylistDescription description={bio} />
          </div>
        )}

        {songs && (
          <section className="pb-8">
            <div className="flex items-center justify-between gap-3 px-6">
              <h2 className="text-xl font-bold">Songs</h2>
              {songs.browseId && (
                <Link href={`/playlist/${songs.browseId}`} className={seeAllClass}>
                  See all
                </Link>
              )}
            </div>
            <PlaylistTrackList tracks={songs.items} gradient={tracksGradient} playlistId={songs.browseId ?? undefined} />
          </section>
        )}

        {RELEASES.map(([key, title]) => {
          const shelf = rated[key];
          if (!filled(shelf)) return null;
          return (
            <ReleaseShelfView
              key={key}
              title={title}
              shelf={shelf}
              loading={Boolean(loadingShelves[key])}
              error={shelfErrors[key]}
              expanded={Boolean(expandedShelves[key])}
              onShowAll={() => showAllReleases(key, shelf)}
            />
          );
        })}

        {videos && (
          <BrowseRow title="Videos">
            {videos.items.map((video, index) => (
              <VideoCard
                key={`${video.videoId}-${index}`}
                video={video}
                playing={Boolean(video.videoId) && currentSong?.videoId === video.videoId}
                onPlay={() => playVideo(index)}
              />
            ))}
          </BrowseRow>
        )}

        {related.length > 0 && (
          <BrowseRow title="Related artists">
            {related.map((item, index) => (
              <RelatedArtistCard key={`${item.browseId}-${index}`} artist={item} />
            ))}
          </BrowseRow>
        )}
      </div>
    </div>
  );
};

const RelatedArtistCard = ({ artist }: { artist: RelatedArtist }) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = artist.thumbnails?.[0]?.url;

  return (
    <Link href={`/artist/${artist.browseId}`} aria-label={`Open ${artist.title}`} className="w-36 shrink-0 text-center sm:w-40">
      <div className="aspect-square overflow-hidden rounded-full bg-secondary">
        {thumbnailUrl && !failed ? (
          <img src={thumbnailUrl} alt="" onError={() => setFailed(true)} className="size-full object-cover" />
        ) : (
          <span className="grid size-full place-items-center">
            <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
          </span>
        )}
      </div>
      <span title={artist.title} className="mt-2 block truncate text-sm font-medium">
        {artist.title}
      </span>
    </Link>
  );
};

const VideoCard = ({
  video,
  playing,
  onPlay,
}: {
  video: ArtistVideo;
  playing: boolean;
  onPlay: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = video.thumbnails?.[0]?.url;
  const views = labeled(video.views, "view", "views");

  return (
    <button
      type="button"
      onClick={onPlay}
      disabled={!video.videoId}
      aria-label={`Play ${video.title}`}
      className="group w-48 shrink-0 cursor-pointer text-left disabled:cursor-default sm:w-56"
    >
      <div className={cn("relative aspect-video overflow-hidden rounded-md bg-secondary", playing && "ring-2 ring-accent")}>
        {thumbnailUrl && !failed ? (
          <img src={thumbnailUrl} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
          </span>
        )}
        <span className={mediaScrimClass}>
          <RevealIcon
            grow
            interactive
            onClick={video.videoId ? onPlay : undefined}
            iconClassName="icon-[solar--play-bold] text-3xl"
          />
        </span>
      </div>
      <span className="mt-2 block w-full">
        <span title={video.title} className="block truncate text-sm font-medium">
          {video.title}
        </span>
        {views && <span className="mt-0.5 block truncate text-xs text-primary-dark">{views}</span>}
      </span>
    </button>
  );
};
