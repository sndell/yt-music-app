/** One grid row of a playlist's track list. */

import { memo, type MouseEvent } from "react";
import { Link, useLocation } from "wouter";
import type { LikeStatus, Track } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
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
  const pad = showAlbum ? "px-3 sm:px-4" : "px-6";

  const available = track.isAvailable && Boolean(track.videoId);

  const handleClick = () => {
    if (!available) return;
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
        onOpenMenu(track, event.clientX, event.clientY);
      }}
      data-menu-open={menuOpen ? "true" : undefined}
      className={cn(
        "group relative h-full w-full overflow-hidden transition-colors",
        available && "hover:bg-primary-light",
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
        className={cn("absolute inset-0 z-0", available ? "cursor-pointer" : "cursor-default")}
      />
      <div
        className={cn(
          "pointer-events-none relative z-0 grid h-full min-h-0 grid-rows-1 content-center items-center gap-4",
          pad,
          showAlbum
            ? showAdded
              ? "grid-cols-[5fr_2fr_1fr] md:grid-cols-[7fr_4fr_2fr_1fr]"
              : "grid-cols-[5fr_1fr] md:grid-cols-[7fr_5fr_1fr]"
            : views
              ? "grid-cols-[1fr_auto] md:grid-cols-[1fr_auto_auto]"
              : "grid-cols-[1fr_auto]"
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {index != null && (
            <span className="w-5 shrink-0 text-right text-sm text-primary-dark tabular-nums">{index}</span>
          )}
          <CoverFrame thumbnails={track.thumbnails} size="md" className="bg-primary-light">
            {available && (
              <span className={mediaScrimClass}>
                <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
              </span>
            )}
          </CoverFrame>
          <div className="flex min-w-0 flex-col items-start overflow-hidden text-start">
            <span className="flex w-full min-w-0 items-center gap-1">
              <ScrollingText className="font-medium">{track.title}</ScrollingText>
              {!showAlbum && track.isExplicit && <ExplicitBadge />}
            </span>
            {showAlbum && (
              <span className="flex w-full min-w-0 items-center gap-1 text-sm text-primary-dark">
                {track.isExplicit && <ExplicitBadge />}
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
        {showAlbum && showAdded && (
          <div className="min-w-0 truncate text-sm text-primary-dark">{addedDate ?? ""}</div>
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
