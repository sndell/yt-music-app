import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useLocation } from "wouter";
import { PyBridge, type LikeStatus, type Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { IconButton } from "@/components/ui/IconButton";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { ScrollingText } from "@/components/ui/ScrollingText";
import { AddToPlaylistMenu } from "@/components/ui/AddToPlaylistPanel";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { ReorderItem, ReorderList, consumeDragClick } from "@/components/ui/reorder";
import { usePlaylist } from "../hooks/usePlaylist.tsx";

const followLink = (event: MouseEvent<HTMLAnchorElement>, href: string, navigate: (to: string) => void) => {
  event.preventDefault();
  event.stopPropagation();
  navigate(href);
};

const TRACK_HEIGHT = 48; // Height of each track item in pixels

/** Row selection (ctrl/shift-click) plus everything the rows can trigger. */
export const PlaylistTrackList = ({
  tracks,
  gradient,
  playlistId,
  title,
  footer,
  actions,
  variant = "collection",
  onReorder,
  tunable,
  removable,
  onRemoveTracks,
  duplicateCounts,
  filterable,
}: {
  tracks: Track[];
  gradient: string;
  playlistId: string | undefined;
  /** Section name above a popular list. Collection lists keep the Track / Album / Duration row. */
  title?: string;
  /** Rendered as the last row, under the tracks. */
  footer?: ReactNode;
  /** Play controls, rendered at the top of the list section. */
  actions?: ReactNode;
  /** Popular lists drop the album column and the column labels. */
  variant?: "collection" | "popular";
  /** Owned playlists. Moves the row through YouTube Music. Switched off while filtering. */
  onReorder?: (from: number, to: number) => void;
  /** Genre tuner for this list's rows. Defaults to off for collections. The artist song list turns it on. */
  tunable?: boolean;
  /** Owned playlist context: rows can be removed through `onRemoveTracks`. */
  removable?: boolean;
  /** Called with the rows the user chose to remove; the page confirms and applies. */
  onRemoveTracks?: (tracks: Track[]) => void;
  /** videoId -> appearances; rows show a badge when it repeats. */
  duplicateCounts?: Map<string, number>;
  /** Shows a filter field above the tracks; searches title, artist and album. */
  filterable?: boolean;
}) => {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [filter, setFilter] = useState("");
  /** Row indexes the user picked with ctrl/shift-click, into `displayTracks`. */
  const [selected, setSelected] = useState<number[]>([]);
  const selectionAnchorRef = useRef<number | null>(null);
  /** Songs to create a playlist with: one from a row menu, or the whole selection. */
  const [creatingFor, setCreatingFor] = useState<string[] | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; videoIds: string[] } | null>(null);
  const { playTrackNext, addTrackToQueue, startMix, playFromPlaylist } = usePlayer();
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } =
    usePlaylist();

  const filterActive = Boolean(filterable && filter.trim());
  const displayTracks = useMemo(() => {
    if (!filterable || !filter.trim()) return tracks;
    // The filter matches the song, its artists and the album, like the
    // in-playlist search on YouTube Music.
    const needle = filter.trim().toLowerCase();
    return tracks.filter(
      (track) =>
        track.title.toLowerCase().includes(needle) ||
        track.artists.some((artist) => artist.name.toLowerCase().includes(needle)) ||
        (track.album?.name.toLowerCase().includes(needle) ?? false),
    );
  }, [tracks, filterable, filter]);

  // A selection pointing past the (filtered) list would bulk-act on wrong rows.
  useEffect(() => {
    setSelected([]);
    selectionAnchorRef.current = null;
  }, [displayTracks]);

  const dragIds = displayTracks.map((track, index) => track.setVideoId || `row-${track.videoId}-${index}`);
  // Stable, so memoized rows don't re-render just because the list scrolled.
  const openMenu = useCallback((track: Track, x: number, y: number) => setMenu({ track, x, y }), []);

  const options = playlists.filter((playlist) => playlist.owned !== false && playlist.playlistId !== "LM");

  useLayoutEffect(() => {
    const rows = rowsRef.current;
    const scroller = rows?.closest(".scrollbar");
    if (!rows || !(scroller instanceof HTMLElement)) return;
    const measure = () => {
      const next = rows.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    if (rows.parentElement) observer.observe(rows.parentElement);
    return () => observer.disconnect();
  }, []);

  const virtualizer = useVirtualizer({
    count: displayTracks.length,
    getScrollElement: () => rowsRef.current?.closest(".scrollbar") as HTMLElement | null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 16,
    scrollMargin,
  });

  const popular = variant === "popular";
  const pad = popular ? "px-6" : "px-3 sm:px-4";
  // Moving rows while a filter hides some of them, or while some are picked,
  // would shift indexes the caller does not know about.
  const reorderLocked = filterActive || selected.length > 0;

  const handleRowSelect = (index: number, event: MouseEvent) => {
    event.preventDefault();
    selectionAnchorRef.current = index;
    setSelected((current) => {
      const set = new Set(current);
      const additive = event.ctrlKey || event.metaKey;
      if (additive) {
        if (set.has(index)) {
          set.delete(index);
        } else {
          set.add(index);
        }
        return [...set].sort((a, b) => a - b);
      }
      return [index];
    });
  };

  const handleRowShiftSelect = (index: number) => {
    const anchor = selectionAnchorRef.current;
    if (anchor == null) {
      setSelected([index]);
      return;
    }
    const [start, end] = anchor < index ? [anchor, index] : [index, anchor];
    const set = new Set(selected);
    for (let i = start; i <= end; i++) set.add(i);
    setSelected([...set]);
  };

  const selectedTracks = [...new Set(selected)].sort((a, b) => a - b).map((index) => displayTracks[index]).filter(Boolean);

  const bulkPlay = () => {
    const [first, ...rest] = selectedTracks;
    if (!first) return;
    playFromPlaylist(first, playlistId, tunable);
    rest.forEach((track) => addTrackToQueue(track));
    setSelected([]);
  };

  return (
    <div className={cn("relative flex flex-col", popular ? "gap-2 pt-1 pb-2" : "gap-3 pt-3 pb-4 sm:pb-6")}>
      <div className="pointer-events-none absolute top-0 right-0 left-0 h-64" style={{ background: gradient }} />
      {popular ? (
        <>
          {actions && <div className={cn("relative", pad)}>{actions}</div>}
          {title && <h2 className={cn("relative text-xl font-bold", pad)}>{title}</h2>}
        </>
      ) : (
        <div className={cn("relative flex flex-wrap items-center gap-3", pad)}>
          {actions}
          {filterable && (
            <label className="ms-auto flex w-full max-w-xs items-center gap-1.5 rounded-full bg-primary-light/80 px-3 py-1.5 text-sm transition-[box-shadow] focus-within:ring-2 focus-within:ring-white/15 sm:w-64">
              <span aria-hidden="true" className="shrink-0 text-base text-primary-dark">
                <span className="icon-[solar--magnifer-linear]" />
              </span>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search songs, artists, albums"
                className="w-full bg-transparent text-primary outline-none placeholder:text-primary-dark/70"
              />
              {filter && (
                <button
                  type="button"
                  aria-label="Clear filter"
                  onClick={() => setFilter("")}
                  className="shrink-0 cursor-pointer text-base text-primary-dark hover:text-primary"
                >
                  <span className="icon-[solar--close-circle-linear]" />
                </button>
              )}
            </label>
          )}
        </div>
      )}
      {!popular && (
        <div className={cn("relative", pad)}>
          {filterActive ? (
            <p className="pb-1.5 text-sm text-primary-dark border-b border-primary" role="status">
              {displayTracks.length === tracks.length
                ? `${tracks.length} songs`
                : `${displayTracks.length} of ${tracks.length} songs`}
            </p>
          ) : (
            <div className="grid grid-cols-[5fr_1fr] border-b border-primary pb-1.5 text-sm text-primary-dark md:grid-cols-[7fr_5fr_1fr]">
              <div>Track</div>
              <div className="max-md:hidden">Album</div>
              <div className="justify-self-end">Duration</div>
            </div>
          )}
        </div>
      )}
      <ReorderList ids={dragIds} axis="y" onMove={(from, to) => onReorder?.(from, to)}>
        <div ref={rowsRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const track = displayTracks[virtualItem.index];
            const reorderable = Boolean(onReorder && track.setVideoId) && !reorderLocked;
            return (
              <ReorderItem
                key={dragIds[virtualItem.index]}
                id={dragIds[virtualItem.index]}
                offsetY={virtualItem.start - scrollMargin}
                height={TRACK_HEIGHT}
                disabled={reorderable ? false : { draggable: true }}
              >
                <PlaylistTrackItem
                  track={track}
                  playlistId={playlistId}
                  tunable={tunable}
                  index={popular ? virtualItem.index + 1 : undefined}
                  showAlbum={!popular}
                  menuOpen={menu?.track === track}
                  selected={selected.includes(virtualItem.index)}
                  duplicateCount={duplicateCounts?.get(track.videoId) ?? undefined}
                  onOpenMenu={openMenu}
                  onSelect={(event) => handleRowSelect(virtualItem.index, event)}
                  onShiftSelect={() => handleRowShiftSelect(virtualItem.index)}
                />
              </ReorderItem>
            );
          })}
        </div>
      </ReorderList>
      {footer}
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
          addToPlaylistVideoIds={[menu.track.videoId]}
          playlists={playlists}
          recommendedPlaylists={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onLoadRecommendations={() => void fetchRecommendedPlaylists()}
          onNewPlaylist={() => {
            setCreatingFor([menu.track.videoId]);
            setMenu(null);
          }}
          onRemoveFromPlaylist={
            onRemoveTracks && removable && menu.track.setVideoId
              ? () => {
                  const track = menu.track;
                  setMenu(null);
                  onRemoveTracks([track]);
                }
              : undefined
          }
        />
      )}
      {addMenu && (
        <AddToPlaylistMenu
          x={addMenu.x}
          y={addMenu.y}
          onClose={() => setAddMenu(null)}
          videoIds={addMenu.videoIds}
          playlists={options}
          recommended={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onNewPlaylist={() => {
            setCreatingFor(addMenu.videoIds);
            setAddMenu(null);
          }}
        />
      )}
      {creatingFor && (
        <CreatePlaylistDialog
          onCancel={() => setCreatingFor(null)}
          onSubmit={async (newTitle, description, privacy) => {
            const created = await createPlaylist(newTitle, description, privacy, creatingFor);
            if (created) setCreatingFor(null);
            return created;
          }}
        />
      )}
      {selectedTracks.length > 0 &&
        (popular ? null : (
          <div className="fixed bottom-24 left-1/2 z-[55] flex -translate-x-1/2 items-center gap-1 rounded-full bg-black px-1.5 py-1.5 shadow-[0_10px_30px_rgb(0_0_0/0.7)]">
            <button
              type="button"
              onClick={bulkPlay}
              className="flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-black bg-white hover:bg-white/85"
              title={`Play ${selectedTracks.length} songs`}
            >
              <span aria-hidden="true" className="icon-[solar--play-bold] text-base" />
              {selectedTracks.length} selected
            </button>
            <IconButton
              iconClass="icon-[solar--add-linear]"
              label="Add to playlist"
              size="sm"
              tone="ghost"
              onClick={(event) => {
                void fetchRecommendedPlaylists();
                const rect = event.currentTarget.getBoundingClientRect();
                setAddMenu({ x: rect.left, y: rect.top - 8, videoIds: selectedTracks.map((track) => track.videoId) });
              }}
            />
            {onRemoveTracks && (
              <IconButton
                iconClass="icon-[solar--trash-bin-minimalistic-linear]"
                label="Remove from playlist"
                size="sm"
                tone="ghost"
                onClick={() => {
                  onRemoveTracks(selectedTracks);
                  setSelected([]);
                }}
              />
            )}
            <IconButton
              iconClass="icon-[solar--close-circle-linear]"
              label="Clear selection"
              size="sm"
              tone="ghost"
              onClick={() => setSelected([])}
            />
          </div>
        ))}
    </div>
  );
};

const PlaylistTrackItem = memo(({
  track,
  playlistId,
  tunable,
  onOpenMenu,
  index,
  showAlbum,
  menuOpen = false,
  selected = false,
  duplicateCount,
  onSelect,
  onShiftSelect,
}: {
  track: Track;
  playlistId?: string;
  /** Genre tuner for clicks on this row. Defaults to off for collections. */
  tunable?: boolean;
  /** Stable across renders, so the row can be memoized. */
  onOpenMenu: (track: Track, x: number, y: number) => void;
  index?: number;
  showAlbum: boolean;
  /** Keeps the row in its hover state while its context menu is open. */
  menuOpen?: boolean;
  /** Part of a ctrl/shift-click selection over the list. */
  selected?: boolean;
  /** Times this song already sits in the playlist; shown as a badge when it repeats. */
  duplicateCount?: number;
  /** Ctrl+click toggles this row in the selection. */
  onSelect: (event: MouseEvent) => void;
  /** Shift+click extends the selection from the last clicked row. */
  onShiftSelect: () => void;
}) => {
  const { playFromPlaylist, rateTrack } = usePlayer();
  const [, navigate] = useLocation();
  const thumbnailUrl = track.thumbnails[0]?.url;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const inlinedUrl = inlined?.from === thumbnailUrl ? inlined.url : null;
  const coverSrc = inlinedUrl ?? thumbnailUrl;
  const showCover = Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl;
  const likeStatus = track.likeStatus ?? "INDIFFERENT";
  const albumName = track.album?.name || "Unknown Album";
  const albumId = track.album?.id;
  const views = track.views != null && track.views > 0 ? track.views.toLocaleString() : null;
  const pad = showAlbum ? "px-3 sm:px-4" : "px-6";

  const handleClick = () => {
    playFromPlaylist(track, playlistId, tunable);
  };

  const handleRate = (rating: LikeStatus) => {
    void rateTrack(track.videoId, likeStatus, rating);
  };

  const handleCoverError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((result) => {
      if (result.success && typeof result.data === "string" && result.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: result.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (!track.isAvailable || !track.videoId) return;
        onOpenMenu(track, event.clientX, event.clientY);
      }}
      data-menu-open={menuOpen ? "true" : undefined}
      className={cn(
        "group relative h-full w-full overflow-hidden transition-colors hover:bg-primary-light",
        (menuOpen || selected) && "bg-primary-light",
        track.isAvailable ? "opacity-100" : "opacity-25"
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          if (consumeDragClick()) return;
          if (event.ctrlKey || event.metaKey) {
            onSelect(event);
            return;
          }
          if (event.shiftKey) {
            onShiftSelect();
            return;
          }
          handleClick();
        }}
        aria-label={`Play ${track.title}`}
        className="absolute inset-0 z-0 cursor-pointer"
      />
      <div
        className={cn(
          "pointer-events-none relative z-0 grid h-full min-h-0 grid-rows-1 content-center items-center gap-4",
          pad,
          showAlbum
            ? "grid-cols-[5fr_1fr] md:grid-cols-[7fr_5fr_1fr]"
            : views
              ? "grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_auto]"
              : "grid-cols-[1fr_auto]"
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {index != null && (
            <span className="w-5 shrink-0 text-right text-sm text-primary-dark tabular-nums">{index}</span>
          )}
          <div className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-primary-light">
            {showCover && coverSrc ? (
              <img
                src={coverSrc}
                alt=""
                draggable={false}
                onError={handleCoverError}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center bg-primary-light">
                <span className="icon-[solar--music-note-linear] text-primary-dark" />
              </div>
            )}
            <span className={mediaScrimClass}>
              <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
            </span>
          </div>
          <div className="flex min-w-0 flex-col items-start overflow-hidden text-start">
            <span className="flex w-full min-w-0 items-center gap-1">
              <ScrollingText className="font-medium">{track.title}</ScrollingText>
              {!showAlbum && track.isExplicit && <ExplicitBadge />}
              {!showAlbum && duplicateCount != null && duplicateCount > 1 && <DuplicateBadge count={duplicateCount} />}
            </span>
            {showAlbum && (
              <span className="flex w-full min-w-0 items-center gap-1 text-sm text-primary-dark">
                {track.isExplicit && <ExplicitBadge />}
                {duplicateCount != null && duplicateCount > 1 && <DuplicateBadge count={duplicateCount} />}
                <ScrollingText>
                  {track.artists.map((artist, artistIndex) => (
                    <span key={`${artist.id}-${artist.name}-${artistIndex}`}>
                      {artistIndex > 0 && ", "}
                      {artist.id ? (
                        <Link
                          href={`/artist/${artist.id}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => followLink(event, `/artist/${artist.id}`, navigate)}
                          className="pointer-events-auto relative z-10 hover:underline"
                        >
                          {artist.name}
                        </Link>
                      ) : (
                        artist.name
                      )}
                    </span>
                  ))}
                </ScrollingText>
              </span>
            )}
          </div>
        </div>
        {showAlbum ? (
          <div className="flex min-w-0 text-start text-primary-dark max-md:hidden">
            {albumId ? (
              <ScrollingText>
                <Link
                  href={`/album/${albumId}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => followLink(event, `/album/${albumId}`, navigate)}
                  className="pointer-events-auto relative z-10 hover:underline"
                >
                  {albumName}
                </Link>
              </ScrollingText>
            ) : (
              <ScrollingText>{albumName}</ScrollingText>
            )}
          </div>
        ) : (
          views && <div className="hidden truncate text-sm text-primary-dark md:block">{views}</div>
        )}
        <div className="shrink-0 justify-self-end text-sm text-primary-dark transition-opacity duration-200 group-hover:opacity-0 group-data-[menu-open=true]:opacity-0">
          {track.duration}
        </div>
      </div>
      <div
        onPointerDown={(event) => event.stopPropagation()}
        className={cn(
          "pointer-events-none absolute inset-y-0 z-10 flex translate-x-4 items-center gap-0.5 bg-linear-to-l from-primary-light from-60% to-transparent pr-1 pl-10 opacity-0 transition-[opacity,translate] duration-200 ease-out",
          showAlbum ? "right-2 sm:right-3" : "right-6",
          "group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100",
          "group-data-[menu-open=true]:pointer-events-auto group-data-[menu-open=true]:translate-x-0 group-data-[menu-open=true]:opacity-100",
          "focus-within:pointer-events-auto focus-within:translate-x-0 focus-within:opacity-100"
        )}
      >
        <IconButton
          iconClass={likeStatus === "LIKE" ? "icon-[solar--like-bold]" : "icon-[solar--like-linear]"}
          label="Like"
          size="sm"
          tone={likeStatus === "LIKE" ? "active" : "ghost"}
          iconScale="dense"
          onClick={() => handleRate("LIKE")}
        />
        <IconButton
          iconClass={likeStatus === "DISLIKE" ? "icon-[solar--dislike-bold]" : "icon-[solar--dislike-linear]"}
          label="Dislike"
          size="sm"
          tone={likeStatus === "DISLIKE" ? "active" : "ghost"}
          iconScale="dense"
          onClick={() => handleRate("DISLIKE")}
        />
      </div>
    </div>
  );
});

const DuplicateBadge = ({ count }: { count: number }) => (
  <span
    title={`This song appears ${count} times in the playlist`}
    className="shrink-0 rounded-full border border-red-400/50 px-1.5 text-[0.65rem] font-medium leading-4 text-red-400/90"
  >
    {count}×
  </span>
);
