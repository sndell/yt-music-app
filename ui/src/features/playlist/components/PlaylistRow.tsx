/** One grid row of a playlist's track list. */

import { memo, type MouseEvent, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import type { LikeStatus, Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { readableAccent } from "@/features/player/lib/coverAccent";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { CoverFrame } from "@/components/ui/CoverFrame";
import { IconButton } from "@/components/ui/IconButton";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { ScrollingText } from "@/components/ui/ScrollingText";
import { consumeDragClick } from "@/components/ui/reorder";
import { formatAddedAt } from "./trackFilter";

const followLink = (event: MouseEvent<HTMLAnchorElement>, href: string, navigate: (to: string) => void) => {
  event.preventDefault();
  event.stopPropagation();
  navigate(href);
};

export const PlaylistRow = memo(({
  track,
  playlistId,
  tunable,
  onOpenMenu,
  index,
  showAlbum,
  showAdded = false,
  menuOpen = false,
  selected = false,
  playing = false,
  playingAccent = null,
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
  /** Adds the date-added column. On for playlists that carry an add time. */
  showAdded?: boolean;
  /** Keeps the row in its hover state while its context menu is open. */
  menuOpen?: boolean;
  /** Part of a ctrl/shift-click selection over the list. */
  selected?: boolean;
  /** This song is the one in the player. */
  playing?: boolean;
  /** The playing song's extracted cover colour, shared by every row. */
  playingAccent?: string | null;
  /** Ctrl+click toggles this row in the selection. */
  onSelect: (event: MouseEvent) => void;
  /** Shift+click extends the selection from the last clicked row. */
  onShiftSelect: () => void;
}) => {
  const { playFromPlaylist, rateTrack } = usePlayer();
  const [, navigate] = useLocation();
  const likeStatus = track.likeStatus ?? "INDIFFERENT";
  const albumName = track.album?.name || "Unknown Album";
  const albumId = track.album?.id;
  const addedDate = formatAddedAt(track.addedAt);
  const views = track.views != null && track.views > 0 ? track.views.toLocaleString() : null;
  const available = track.isAvailable && Boolean(track.videoId);

  const tone = playing && playingAccent ? readableAccent(playingAccent) : null;

  const handleClick = () => {
    if (!available) return;
    playFromPlaylist(track, playlistId, tunable);
  };

  const handleRate = (rating: LikeStatus) => {
    void rateTrack(track.videoId, likeStatus, rating);
  };

  const artists = track.artists.map((artist, artistIndex) => (
    <span key={`${artist.id}-${artist.name}-${artistIndex}`} className="inline-flex min-w-0 items-center">
      {artistIndex > 0 && <span className="text-primary-dark/60">, </span>}
      {artist.id ? (
        <Link
          href={`/artist/${artist.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => followLink(event, `/artist/${artist.id}`, navigate)}
          className="pointer-events-auto relative z-10 truncate hover:text-primary hover:underline"
        >
          {artist.name}
        </Link>
      ) : (
        <span className="truncate">{artist.name}</span>
      )}
    </span>
  ));

  const albumLink = showAlbum ? (
    <span className="inline-flex min-w-0 items-center">
      {albumId ? (
        <Link
          href={`/album/${albumId}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => followLink(event, `/album/${albumId}`, navigate)}
          className="pointer-events-auto relative z-10 truncate hover:text-primary hover:underline"
        >
          {albumName}
        </Link>
      ) : (
        <span className="truncate">{albumName}</span>
      )}
    </span>
  ) : null;

  const hoverActions = (
    <div
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "pointer-events-none absolute inset-y-0 right-2 z-10 flex translate-x-3 items-center gap-0.5 pl-6 pr-1 opacity-0 transition-[opacity,translate] duration-200 ease-out sm:right-3",
        "group-hover:pointer-events-auto group-hover:translate-x-0 group-hover:opacity-100",
        "group-data-[menu-open=true]:pointer-events-auto group-data-[menu-open=true]:translate-x-0 group-data-[menu-open=true]:opacity-100",
        "focus-within:pointer-events-auto focus-within:translate-x-0 focus-within:opacity-100",
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
  );

  const row = (className: string, children: ReactNode) => (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (!available) return;
        onOpenMenu(track, event.clientX, event.clientY);
      }}
      data-menu-open={menuOpen ? "true" : undefined}
      className={cn("group relative h-full w-full", className)}
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
        className={cn("absolute inset-0 z-0", available ? "cursor-pointer" : "cursor-default")}
      />
      {children}
      {hoverActions}
    </div>
  );

  return row(
    cn("transition-colors", !track.isAvailable && "opacity-30"),
    <div
      className={cn(
        "pointer-events-none relative flex h-full w-full items-center gap-4 px-4 transition-colors sm:px-6",
        available && "group-hover:bg-white/[0.06]",
        (menuOpen || selected) && "bg-white/[0.09]",
        playing && "bg-white/[0.045]",
      )}
    >
      {playing && (
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-3 left-0 w-0.5 rounded-full", !tone && "bg-accent")}
          style={tone ? { backgroundColor: tone } : undefined}
        />
      )}
      <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-4 lg:grid-cols-[minmax(0,1fr)_5rem_3.5rem]">
        <div className="flex min-w-0 items-center gap-3.5">
          {index != null && (
            <span className="w-5 shrink-0 text-right text-[13px] tabular-nums text-primary-dark/70">{index}</span>
          )}
          <CoverFrame thumbnails={track.thumbnails} size="lg" className="bg-primary-light">
            {available && (
              <span className={mediaScrimClass}>
                <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
              </span>
            )}
          </CoverFrame>
          <div className="flex min-w-0 flex-col items-start overflow-hidden text-start">
            <span
              className={cn("flex w-full min-w-0 items-center gap-1.5", playing && !tone && "text-accent")}
              style={playing && tone ? { color: tone } : undefined}
            >
              <ScrollingText className="text-[15px] font-semibold">{track.title}</ScrollingText>
              {track.isExplicit && <ExplicitBadge />}
            </span>
            <span className="flex w-full min-w-0 items-center gap-1.5 text-[13px] text-primary-dark">
              <span className="inline-flex min-w-0 items-center truncate">{artists}</span>
              {showAlbum && albumLink && (
                <>
                  <span aria-hidden="true" className="shrink-0 text-primary-dark/40">
                    ·
                  </span>
                  {albumLink}
                </>
              )}
            </span>
          </div>
        </div>
        {!showAlbum && views && (
          <div className="hidden truncate text-[13px] text-primary-dark transition-opacity duration-200 lg:block group-hover:opacity-0 group-data-[menu-open=true]:opacity-0">
            {views}
          </div>
        )}
        {showAlbum && showAdded && (
          <div className="hidden w-28 truncate text-[13px] tabular-nums text-primary-dark/70 transition-opacity duration-200 lg:block group-hover:opacity-0 group-data-[menu-open=true]:opacity-0">
            {addedDate ?? ""}
          </div>
        )}
        <div className="shrink-0 justify-self-end text-[13px] tabular-nums text-primary-dark transition-opacity duration-200 group-hover:opacity-0 group-data-[menu-open=true]:opacity-0">
          {track.duration}
        </div>
      </div>
    </div>,
  );
});
