import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import type { AlbumDetails, LikeStatus } from "@/lib/api";
import type { Artist } from "@/lib/api/types";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { BrowseCard, BrowseRow } from "@/components/ui/BrowseCard";
import { PlaybackButtons, type PlaybackExtraAction } from "@/components/ui/PlaybackButtons";
import { CollectionHeader, CollectionMeta } from "@/components/ui/CollectionHeader";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StickyCollectionBar } from "@/components/ui/StickyCollectionBar";
import { useAlbumLibrary } from "../hooks/useAlbumLibrary";
import { useEdgeFade } from "@/components/ui/useEdgeFade";
import { PlaylistTrackList } from "@/features/playlist/components/PlaylistTrackList";
import { hexToRgba } from "@/util/hex_to_rgba";

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
  const { playPlaylist, trackRatings, trueShuffle } = usePlayer();
  const { isSaved, rateAlbum } = useAlbumLibrary();
  const [album, setAlbum] = useState<AlbumDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState(id);
  const [attempt, setAttempt] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
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
    void showCachedThenRefresh(
      (forceRefresh) => PyBridge.getAlbum(id, forceRefresh),
      (data) => {
        if (!data.title) return;
        setAlbum(data);
        setError(null);
      },
      () => active,
    ).then((result) => {
      if (!active || !result || result.success) return;
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

  useEdgeFade(scrollContainerRef, { top: false }, album?.tracks.length);

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

  const trackWash = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 0.18)}, transparent)`
    : "transparent";

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 0.4) : "black";

  const albumMeta = [
    type ? <span key="type" className="capitalize">{type}</span> : null,
    year,
    artists.length > 0 ? <ArtistLinks key="artists" artists={artists} /> : null,
    `${trackCount} ${trackCount === 1 ? "song" : "songs"}`,
  ];

  const shuffleMenu =
    audioPlaylistId && rated.tracks.length > 0
      ? { onShuffle: () => play("shuffle"), onTrueShuffle: () => void trueShuffle(rated.tracks) }
      : undefined;

  const albumRef = { browseId: rated.browseId, audioPlaylistId };
  const saved = isSaved(albumRef);
  const extraActions: PlaybackExtraAction[] = [];
  if (audioPlaylistId) {
    extraActions.push({
      label: saved ? "Remove album from your library" : "Save album to your library",
      iconClass: saved ? "icon-[solar--heart-bold]" : "icon-[solar--heart-linear]",
      active: saved,
      onClick: () => {
        if (saved) {
          setConfirmingRemove(true);
          return;
        }
        void rateAlbum(albumRef, true);
      },
    });
  }

  const playback = audioPlaylistId ? (
    <PlaybackButtons onPlay={() => play("play")} shuffleMenu={shuffleMenu} extra={extraActions} />
  ) : null;

  return (
    <div className="@container relative flex flex-1 flex-col overflow-hidden">
      <StickyCollectionBar
        visible={isScrolled}
        background={stickyBg}
        thumbnailUrl={thumbnailUrl}
        title={title}
        coverFallback
        meta={<CollectionMeta className="text-xs" parts={albumMeta} />}
        onPlay={audioPlaylistId ? () => play("play") : undefined}
        shuffleMenu={shuffleMenu}
        extra={extraActions}
      />

      <div
        key={id}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="overflow-x-hidden overflow-y-auto flex-1 scrollbar [overflow-anchor:none]"
      >
        <CollectionHeader
          headerRef={headerRef}
          eyebrow="Album"
          title={title}
          artworkUrl={thumbnailUrl}
          description={description}
          meta={albumMeta}
          dominantColor={dominantColor}
          actions={playback}
        />

        <PlaylistTrackList
          tracks={rated.tracks}
          gradient={trackWash}
          playlistId={audioPlaylistId ?? undefined}
        />

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

      {confirmingRemove && (
        <ConfirmDialog
          title="Remove album from your library?"
          message={
            <p>
              <span className="font-semibold text-primary">{title}</span> will be removed from your library. You can
              add it back any time.
            </p>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          onConfirm={() => rateAlbum(albumRef, false)}
          onCancel={() => setConfirmingRemove(false)}
        />
      )}
    </div>
  );
};
