import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { PyBridge, showCachedThenRefresh, type LikeStatus, type PlaylistDetails, type PlaylistItemRef, type PlaylistSummary } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";
import { PlaybackButtons } from "@/components/ui/PlaybackButtons";
import { StickyCollectionBar } from "@/components/ui/StickyCollectionBar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EditPlaylistDialog } from "@/components/ui/EditPlaylistDialog";
import { useEdgeFade } from "@/components/ui/useEdgeFade";
import { useToast } from "@/components/ui/Toast";
import type { PlaybackExtraAction } from "@/components/ui/PlaybackButtons";
import { moveItem } from "@/lib/orderMap";
import { collectionCoverClass, collectionHeaderClass, collectionTitleClass, collectionWash } from "@/components/ui/collectionChrome";
import { usePlaylist } from "../hooks/usePlaylist.tsx";
import { PlaylistDescription } from "../components/PlaylistDescription";
import { PlaylistTrackList } from "../components/PlaylistTrackList";
import type { Track } from "@/lib/api";

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
  privacy?: string;
  className?: string;
}) => {
  const details = [year, `${trackCount} songs`, privacy?.toLowerCase()].filter(Boolean);

  return (
    <p className={cn("flex w-full min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 font-medium text-primary-dark", className)}>
      {author ? <span className="min-w-0 max-w-full text-primary wrap-break-word">{author}</span> : null}
      {details.map((detail, index) => (
        <span key={detail} className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap capitalize">
          {(author || index > 0) && (
            <span className="text-sm leading-none" aria-hidden="true">
              •
            </span>
          )}
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
      <div className={collectionHeaderClass}>
        {thumbnailUrl && !failed ? (
          <img
            src={thumbnailUrl}
            alt=""
            onError={() => setFailed(true)}
            className={cn(collectionCoverClass, "rounded-md object-cover shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]")}
          />
        ) : (
          <div className={cn(collectionCoverClass, "grid place-items-center rounded-md bg-primary-light")}>
            <span className="icon-[solar--music-note-linear] text-4xl text-primary-dark" />
          </div>
        )}
        <div className="min-w-0 flex-1 @lg:self-end">
          <h1 title={summary.title} className={collectionTitleClass}>
            {summary.title}
          </h1>
          <p className="flex items-center gap-2 pt-3 text-sm text-primary-dark" role="status">
            <span className="icon-[solar--loader-linear] animate-spin text-base" />
            Loading tracks
          </p>
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pt-3" aria-hidden="true">
            <div className="h-3.5 w-28 rounded-full bg-secondary/70" />
            <div className="h-3.5 w-14 rounded-full bg-secondary/70" />
            <div className="h-3.5 w-20 rounded-full bg-secondary/70" />
            <div className="h-3.5 w-12 rounded-full bg-secondary/70" />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col pt-3 pb-4 sm:pb-6">
        <div className="relative flex flex-wrap items-center gap-3 px-3 sm:px-4" aria-hidden="true">
          <div className="size-10 shrink-0 rounded-full bg-secondary" />
          <div className="size-8 shrink-0 rounded-full bg-secondary/70" />
          <div className="size-8 shrink-0 rounded-full bg-secondary/70" />
          <div className="ms-auto h-8 w-full max-w-xs shrink-0 rounded-full bg-secondary/70 sm:w-64" />
          <div className="size-8 shrink-0 rounded-full bg-secondary/70" />
        </div>
        <div className="relative mt-3 px-3 sm:px-4">
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
                className="grid h-12 grid-cols-[5fr_1fr] items-center gap-4 px-3 sm:px-4 md:grid-cols-[7fr_5fr_1fr]"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="size-10 shrink-0 rounded-md bg-secondary" />
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
  const [, navigate] = useLocation();
  const { playlists, fetchPlaylists, removeFromPlaylist, restorePlaylistItem, editPlaylist, deletePlaylist, ratePlaylist } =
    usePlaylist();
  const { playPlaylist, trackRatings, trueShuffle } = usePlayer();
  const ratingsRef = useRef(trackRatings);
  ratingsRef.current = trackRatings;
  const [playlist, setPlaylist] = useState<PlaylistDetails | null>(null);
  const [loadedId, setLoadedId] = useState(id);
  const [isScrolled, setIsScrolled] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Track[] | null>(null);
  const [editing, setEditing] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const { showToast } = useToast();

  if (id !== loadedId) {
    setLoadedId(id);
    setPlaylist(null);
    setIsScrolled(false);
  }

  useEffect(() => {
    if (!id) return;
    let active = true;
    void showCachedThenRefresh(
      (forceRefresh) => PyBridge.getPlaylistItems(id, forceRefresh),
      (data) => {
        if (!data.title || !Array.isArray(data.tracks)) return;
        setPlaylist(withRatings(data, ratingsRef.current));
      },
      () => active,
    );
    return () => {
      active = false;
    };
  }, [id]);

  // A rename, visibility change, or added song from the sidebar should refresh
  // the playlist view when it is showing that playlist.
  useEffect(() => {
    if (!id) return;
    let active = true;
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ playlistId?: string }>).detail;
      if (!detail?.playlistId || detail.playlistId !== id) return;
      void PyBridge.getPlaylistItems(id, true).then((result) => {
        if (!active || !result.success || !result.data.title) return;
        setPlaylist(withRatings(result.data, ratingsRef.current));
      });
    };
    window.addEventListener("ytmusic-playlist-changed", onChanged);
    return () => {
      active = false;
      window.removeEventListener("ytmusic-playlist-changed", onChanged);
    };
  }, [id]);

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

  useEdgeFade(scrollContainerRef, { top: false }, playlist?.tracks.length);

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

  const wash = collectionWash(dominantColor);

  const stickyBg = dominantColor ? hexToRgba(dominantColor, 0.4) : "black";

  const play = (mode: "play" | "shuffle") => {
    if (!id) return;
    void playPlaylist(id, mode);
  };

  const shuffleMenu =
    playlist.tracks.length > 0
      ? { onShuffle: () => play("shuffle"), onTrueShuffle: () => void trueShuffle(playlist.tracks) }
      : undefined;

  const reorderTrack = (from: number, to: number) => {
    if (!id || !playlist) return;
    const previous = playlist.tracks;
    const next = moveItem(previous, from, to);
    if (next === previous) return;
    const moved = next[to];
    if (!moved?.setVideoId) return;
    const before = next[to + 1]?.setVideoId ?? "";
    setReorderError(null);
    setPlaylist({ ...playlist, tracks: next });
    void PyBridge.movePlaylistItem(id, moved.setVideoId, before).then((result) => {
      if (result.success) return;
      setPlaylist((current) => (current && current.id === id ? { ...current, tracks: previous } : current));
      setReorderError(result.error.message || "Could not reorder this playlist");
    });
  };

  const runRemoval = async (): Promise<boolean> => {
    if (!id || !playlist || !removing) return false;
    const snapshot = playlist.tracks;
    const items: PlaylistItemRef[] = removing
      .filter((track) => track.setVideoId)
      .map((track) => ({ videoId: track.videoId, setVideoId: track.setVideoId }));
    if (items.length === 0) return true;
    // Drop the rows right away; only roll them back when YouTube says no.
    const removedSet = new Set(items.map((item) => item.setVideoId));
    setPlaylist((current) => (current && current.id === id ? { ...current, tracks: snapshot.filter((track) => !removedSet.has(track.setVideoId)) } : current));
    const ok = await removeFromPlaylist(id, items);
    if (!ok) {
      setPlaylist((current) => (current && current.id === id ? { ...current, tracks: snapshot } : current));
      return false;
    }
    const sorted = [...items].sort(
      (a, b) => snapshot.findIndex((track) => track.setVideoId === a.setVideoId) - snapshot.findIndex((track) => track.setVideoId === b.setVideoId),
    );
    const undo = async () => {
      // One row can go back to its exact spot: re-add, then move it before its
      // old successor. Several rows go back to the end, keeping their order.
      for (const item of sorted) {
        if (id == null) return;
        const index = snapshot.findIndex((track) => track.setVideoId === item.setVideoId);
        const before = sorted.length === 1 && index >= 0 && index < snapshot.length - 1 ? (snapshot[index + 1].setVideoId || null) : null;
        await restorePlaylistItem(id, item.videoId, before);
      }
    };
    showToast(
      sorted.length === 1 ? `Removed 1 song from ${playlist.title}` : `Removed ${sorted.length} songs from ${playlist.title}`,
      "success",
      { label: "Undo", onClick: () => void undo() },
    );
    return true;
  };

  const removable = Boolean(id && playlist?.owned && id !== "LM" && playlist.tracks.some((track) => track.setVideoId));

  const editable = Boolean(id && playlist?.owned && id !== "LM");

  const saved = Boolean(id && playlists.some((entry) => entry.playlistId === id));
  const extraActions: PlaybackExtraAction[] = [];
  if (id && !playlist?.owned) {
    extraActions.push({
      label: saved ? "Remove from your library" : "Save playlist to your library",
      iconClass: saved ? "icon-[solar--heart-bold]" : "icon-[solar--heart-linear]",
      active: saved,
      onClick: () => {
        if (!id) return;
        void ratePlaylist(id, saved).then((ok) => {
          if (ok) void fetchPlaylists();
        });
      },
    });
  }
  if (editable) {
    extraActions.push({
      label: "Edit playlist",
      iconClass: "icon-[solar--pen-2-linear]",
      onClick: () => setEditing(true),
    });
  }

  return (
    <div className="@container relative flex flex-1 flex-col overflow-hidden">
      <StickyCollectionBar
        visible={isScrolled}
        background={stickyBg}
        thumbnailUrl={thumbnailUrl}
        title={title}
        meta={
          <PlaylistMeta
            author={author?.name ?? ""}
            year={year}
            trackCount={trackCount}
            privacy={privacy}
            className="text-sm leading-5"
          />
        }
        onPlay={() => play("play")}
        shuffleMenu={shuffleMenu}
        extra={extraActions}
        columnHeaders
      />

      {/* Scrollable content */}
      <div
        key={id}
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="overflow-x-hidden overflow-y-auto flex-1 scrollbar [overflow-anchor:none]"
      >
        {/* Original full header */}
        <div
          ref={headerRef}
          className={collectionHeaderClass}
          style={{ background: wash.header }}
        >
          {thumbnailUrl && (
            <img
              src={thumbnailUrl}
              alt={title}
              className={cn(collectionCoverClass, "rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]")}
            />
          )}
          {/* Stays on the cover's bottom edge while the description height eases, so hiding it doesn't snap the text down. */}
          <div className="min-w-0 flex-1 text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)] @lg:self-end">
            <h1 title={title} className={collectionTitleClass}>
              {title}
            </h1>
            <PlaylistDescription description={description} />
            <PlaylistMeta
              author={author?.name ?? ""}
              year={year}
              trackCount={trackCount}
              privacy={privacy}
              className="pt-3"
            />
          </div>
        </div>

        {reorderError && <p className="px-6 pt-4 text-sm text-red-400">{reorderError}</p>}
        <PlaylistTrackList
          tracks={playlist.tracks}
          gradient={wash.tracks}
          playlistId={id}
          onReorder={reorderTrack}
          removable={removable}
          onRemoveTracks={(tracks) => setRemoving(tracks)}
          filterable
          actions={
            <PlaybackButtons onPlay={() => play("play")} shuffleMenu={shuffleMenu} extra={extraActions} />
          }
        />
      </div>

      {removing && (
        <ConfirmDialog
          title={removing.length === 1 ? "Remove song from playlist?" : `Remove ${removing.length} songs from playlist?`}
          message={
            <p>
              <span className="font-semibold text-primary">{playlist.title}</span> will no longer contain{" "}
              {removing.length === 1 ? (
                <span className="font-semibold text-primary">{removing[0].title}</span>
              ) : (
                `${removing.length} songs`
              )}
              . You can undo right after.
            </p>
          }
          confirmLabel="Remove"
          busyLabel="Removing…"
          danger
          onConfirm={runRemoval}
          onCancel={() => setRemoving(null)}
        />
      )}

      {editing && playlist && id && (
        <EditPlaylistDialog
          initialTitle={title}
          initialDescription={description ?? ""}
          initialPrivacy={privacy ?? "PRIVATE"}
          onSubmit={async (patch) => {
            const ok = await editPlaylist(id, {
              ...(patch.title !== title ? { title: patch.title } : {}),
              ...(patch.description !== (description ?? "") ? { description: patch.description } : {}),
              ...(patch.privacy !== privacy ? { privacy: patch.privacy } : {}),
            });
            if (ok) {
              setPlaylist((current) =>
                current && current.id === id
                  ? { ...current, title: patch.title, description: patch.description, privacy: patch.privacy }
                  : current,
              );
            }
            return ok;
          }}
          onDelete={async () => {
            if (!id) return false;
            const ok = await deletePlaylist(id);
            if (ok) {
              showToast("Playlist deleted");
              setEditing(false);
              navigate("/");
            }
            return ok;
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </div>
  );
};
