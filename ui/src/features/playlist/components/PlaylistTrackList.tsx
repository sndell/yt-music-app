import { useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useLocation } from "wouter";
import type { LikeStatus, Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { IconButton } from "@/components/ui/IconButton";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { ReorderItem, ReorderList, consumeDragClick } from "@/components/ui/reorder";

const followLink = (event: MouseEvent<HTMLAnchorElement>, href: string, navigate: (to: string) => void) => {
  event.preventDefault();
  event.stopPropagation();
  navigate(href);
};

const TRACK_HEIGHT = 48; // Height of each track item in pixels

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
  /** Owned playlists. Moves the row through YouTube Music. */
  onReorder?: (from: number, to: number) => void;
  /** Genre tuner for this list's rows. Defaults to off for collections. The artist song list turns it on. */
  tunable?: boolean;
}) => {
  const rowsRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ track: Track; x: number; y: number } | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const { playTrackNext, addTrackToQueue, startMix } = usePlayer();
  const dragIds = tracks.map((track, index) => track.setVideoId || `row-${track.videoId}-${index}`);

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
    count: tracks.length,
    getScrollElement: () => rowsRef.current?.closest(".scrollbar") as HTMLElement | null,
    estimateSize: () => TRACK_HEIGHT,
    overscan: 16,
    scrollMargin,
  });

  const popular = variant === "popular";
  const pad = popular ? "px-6" : "px-3 sm:px-4";

  return (
    <div className={cn("relative flex flex-col", popular ? "gap-2 pt-1 pb-2" : "gap-3 pt-3 pb-4 sm:pb-6")}>
      <div className="pointer-events-none absolute top-0 right-0 left-0 h-64" style={{ background: gradient }} />
      {actions && <div className={cn("relative", pad)}>{actions}</div>}
      {popular ? (
        title && <h2 className={cn("relative text-xl font-bold", pad)}>{title}</h2>
      ) : (
        <div className={cn("relative", pad)}>
          <div className="grid grid-cols-[5fr_1fr] border-b border-primary pb-1.5 text-sm text-primary-dark md:grid-cols-[7fr_5fr_1fr]">
            <div>Track</div>
            <div className="max-md:hidden">Album</div>
            <div className="justify-self-end">Duration</div>
          </div>
        </div>
      )}
      <ReorderList ids={dragIds} axis="y" onMove={(from, to) => onReorder?.(from, to)}>
        <div ref={rowsRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const track = tracks[virtualItem.index];
            const reorderable = Boolean(onReorder && track.setVideoId);
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
                  grabbable={reorderable}
                  menuOpen={menu?.track === track}
                  onOpenMenu={(x, y) => setMenu({ track, x, y })}
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
        />
      )}
    </div>
  );
};

const PlaylistTrackItem = ({
  track,
  playlistId,
  tunable,
  onOpenMenu,
  index,
  showAlbum,
  grabbable = false,
  menuOpen = false,
}: {
  track: Track;
  playlistId?: string;
  /** Genre tuner for clicks on this row. Defaults to off for collections. */
  tunable?: boolean;
  onOpenMenu: (x: number, y: number) => void;
  index?: number;
  showAlbum: boolean;
  grabbable?: boolean;
  /** Keeps the row in its hover state while its context menu is open. */
  menuOpen?: boolean;
}) => {
  const { playFromPlaylist, rateTrack } = usePlayer();
  const [, navigate] = useLocation();
  const thumbnailUrl = track.thumbnails[0]?.url;
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
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

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (!track.isAvailable || !track.videoId) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
      data-menu-open={menuOpen ? "true" : undefined}
      className={cn(
        "group relative h-full w-full overflow-hidden transition-colors hover:bg-primary-light",
        menuOpen && "bg-primary-light",
        track.isAvailable ? "opacity-100" : "opacity-25"
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (consumeDragClick()) return;
          handleClick();
        }}
        aria-label={`Play ${track.title}`}
        className={cn("absolute inset-0 z-0", grabbable ? "cursor-grab" : "cursor-pointer")}
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
            {thumbnailUrl && failedUrl !== thumbnailUrl ? (
              <img
                src={thumbnailUrl}
                alt=""
                draggable={false}
                onError={() => setFailedUrl(thumbnailUrl)}
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
              <span className="min-w-0 truncate font-medium">{track.title}</span>
              {!showAlbum && track.isExplicit && <ExplicitBadge />}
            </span>
            {showAlbum && (
              <span className="flex w-full min-w-0 items-center gap-1 text-sm text-primary-dark">
                {track.isExplicit && <ExplicitBadge />}
                <span className="truncate">
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
                </span>
              </span>
            )}
          </div>
        </div>
        {showAlbum ? (
          <div className="flex min-w-0 text-start text-primary-dark max-md:hidden">
            {albumId ? (
              <Link
                href={`/album/${albumId}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => followLink(event, `/album/${albumId}`, navigate)}
                className="pointer-events-auto relative z-10 w-full truncate hover:underline"
              >
                {albumName}
              </Link>
            ) : (
              <span className="w-full truncate">{albumName}</span>
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
};
