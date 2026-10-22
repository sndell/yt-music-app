import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { largestCover, useVibrantCover } from "@/features/player/lib/coverAccent";
import { IconButton } from "@/components/ui/IconButton";
import { AddToPlaylistMenu } from "@/components/ui/AddToPlaylistPanel";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { SongListMenu } from "@/components/ui/SongListMenu";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { ReorderItem, ReorderList } from "@/components/ui/reorder";
import { usePlaylist } from "../hooks/usePlaylist.tsx";
import { sortTracks, visibleTracks, type TrackSort } from "./trackFilter";
import { PlaylistRow } from "./PlaylistRow";

const TRACK_HEIGHT = 60;

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
  filterable,
  hasMore = false,
  totalCount,
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
  /** Shows a filter field above the tracks; searches title, artist and album. */
  filterable?: boolean;
  /** True while the remaining pages are still loading. */
  hasMore?: boolean;
  /** The real total when `tracks` is only the loaded part, so counts stay honest. */
  totalCount?: number;
}) => {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [filter, setFilter] = useState("");
  /** Kebab menu beside the search field. */
  const [listMenu, setListMenu] = useState<{ x: number; y: number; trigger: HTMLButtonElement } | null>(null);
  /** Narrows the list to songs that appear more than once. Set from the kebab. */
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  /** Rows' order. `playlist` is YouTube Music's own; the kebab switches it. */
  const [sort, setSort] = useState<TrackSort>("playlist");
  /** Row indexes the user picked with ctrl/shift-click, into `displayTracks`. */
  const [selected, setSelected] = useState<number[]>([]);
  const selectionAnchorRef = useRef<number | null>(null);
  /** Songs to create a playlist with: one from a row menu, or the whole selection. */
  const [creatingFor, setCreatingFor] = useState<string[] | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number; videoIds: string[] } | null>(null);
  const { playTrackNext, addTrackToQueue, startMix, playFromPlaylist, currentSong, queue, currentQueueIndex } =
    usePlayer();
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } =
    usePlaylist();

  // The playing row borrows the queue's cover colour: the queue's own track
  // carries the largest thumb and the data-URL sample the queue extracts from,
  // so the playlist row reads the same accent it does.
  const currentWatchTrack = currentQueueIndex >= 0 ? queue[currentQueueIndex] ?? null : null;
  const coverUrl =
    largestCover(currentWatchTrack) ?? currentSong?.thumbnails?.reduce((best, thumb) => ((thumb.width ?? 0) > (best.width ?? 0) ? thumb : best))?.url;
  const sampleUrl =
    currentWatchTrack?.thumbnail?.find((thumb) => thumb.url?.startsWith("data:"))?.url ??
    currentSong?.thumbnails?.find((thumb) => thumb.url?.startsWith("data:"))?.url;
  const playingAccent = useVibrantCover(coverUrl, currentSong?.videoId, sampleUrl);

  const filterActive = Boolean(filterable && filter.trim());
  const displayTracks = useMemo(
    () => sortTracks(visibleTracks(tracks, { search: filter, duplicatesOnly }), sort),
    [tracks, filter, duplicatesOnly, sort],
  );

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
  const pad = popular ? "px-6" : "px-4 sm:px-6";
  // A playlist carries its real size in the header while only part of it has
  // loaded, so the count line reports that size until the last page lands.
  const knownTotal = hasMore && totalCount != null && totalCount > tracks.length ? totalCount : tracks.length;
  // Playlists carry an add time per track; albums and artist song lists do not,
  // so only the collection lists that have one grow an "Added" column.
  const showAdded = !popular && tracks.some((track) => track.addedAt != null);
  // Either narrowing control hides rows; the count line replaces the column heads.
  const narrowing = filterActive || duplicatesOnly;
  // A date sort shows rows out of the playlist's own order, so dragging one to a
  // new slot could not map back to a real position.
  const sorted = sort !== "playlist";
  // Moving rows while a filter hides some of them, while finding duplicates
  // groups them, while a date sort reorders them, while some are picked, or
  // while the rest of a paged playlist is still loading would shift indexes the
  // caller does not know about: the last loaded row is not the last row, so a
  // drop at the bottom would move the song to the real end. Finding duplicates
  // keeps dragging off entirely.
  const reorderLocked = narrowing || sorted || selected.length > 0 || hasMore;

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
    // Unavailable rows can be selected for bulk remove/add; skip them here so
    // an unplayable song never becomes the track the queue starts on.
    const [first, ...rest] = selectedTracks.filter((track) => track.isAvailable && track.videoId);
    if (!first) return;
    playFromPlaylist(first, playlistId, tunable);
    rest.forEach((track) => addTrackToQueue(track));
    setSelected([]);
  };

  const searchClass = "rounded-full bg-white/10 focus-within:bg-white/15";

  return (
    <div className={cn("relative flex flex-col", popular ? "gap-2 pt-1 pb-2" : "gap-2 pt-4 pb-4 sm:pb-6")}>
      <div className="pointer-events-none absolute top-0 right-0 left-0 h-64" style={{ background: gradient }} />
      {popular ? (
        <>
          {actions && <div className={cn("relative", pad)}>{actions}</div>}
          {title && <h2 className={cn("relative text-xl font-bold", pad)}>{title}</h2>}
        </>
      ) : (
        <div className={cn("relative flex flex-wrap items-center gap-3", pad)}>
          {actions}
          <p className="text-xs font-medium tracking-[0.14em] text-primary-dark uppercase" role="status">
            {narrowing ? `${displayTracks.length} of ${knownTotal} songs` : `${knownTotal} ${knownTotal === 1 ? "song" : "songs"}`}
          </p>
          {hasMore && <span className="icon-[solar--loader-linear] animate-spin text-sm text-primary-dark" aria-hidden="true" />}
          <div className="ms-auto flex items-center gap-2">
            {filterable && (
              <>
                <label
                  className={cn(
                    "flex w-full max-w-xs items-center gap-2 px-3 py-1.5 text-sm transition-colors sm:w-64",
                    searchClass,
                  )}
                >
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
                <IconButton
                  iconClass="icon-[solar--menu-dots-bold] rotate-90"
                  label="Song list options"
                  size="sm"
                  tone="ghost"
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    const rect = trigger.getBoundingClientRect();
                    setListMenu((current) => (current ? null : { x: rect.left, y: rect.bottom + 4, trigger }));
                  }}
                />
              </>
            )}
          </div>
        </div>
      )}
      {narrowing && displayTracks.length === 0 && (
        <p className={cn("relative text-sm text-primary-dark", pad)} role="status">
          {duplicatesOnly ? "No duplicate songs in this playlist" : "No songs match your search"}
        </p>
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
                <PlaylistRow
                  track={track}
                  playlistId={playlistId}
                  tunable={tunable}
                  index={popular ? virtualItem.index + 1 : undefined}
                  showAlbum={!popular}
                  showAdded={showAdded}
                  menuOpen={menu?.track === track}
                  selected={selected.includes(virtualItem.index)}
                  playing={Boolean(track.videoId) && currentSong?.videoId === track.videoId}
                  playingAccent={playingAccent}
                  onOpenMenu={openMenu}
                  onSelect={(event) => handleRowSelect(virtualItem.index, event)}
                  onShiftSelect={() => handleRowShiftSelect(virtualItem.index)}
                />
              </ReorderItem>
            );
          })}
        </div>
      </ReorderList>
      {hasMore && (
        <div className={cn("relative flex items-center justify-center gap-2 py-4 text-sm text-primary-dark", pad)} role="status">
          <span className="icon-[solar--loader-linear] animate-spin text-base" aria-hidden="true" />
          Loading songs
        </div>
      )}
      {footer}
      {listMenu && (
        <SongListMenu
          x={listMenu.x}
          y={listMenu.y}
          trigger={listMenu.trigger}
          duplicatesOnly={duplicatesOnly}
          onToggleDuplicates={() => setDuplicatesOnly((current) => !current)}
          sort={sort}
          onSort={setSort}
          onClose={() => setListMenu(null)}
        />
      )}
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
