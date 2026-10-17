/** Split out of Home.tsx. */

import { useState } from "react";
import type { HomeItem, HomeShelf } from "@/lib/api";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { IconButton } from "@/components/ui/IconButton";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { isVideoMedia } from "@/components/ui/mediaFrame";
import { SnapRow } from "@/components/ui/SnapRow";
import { cn } from "@/util/cn";
import { albumOpenId, itemKey } from "./homeItem";

export const HomeRow = ({
  shelf,
  currentVideoId,
  isMenuTarget,
  onOpen,
  onOpenMenu,
  onPlayAlbum,
  onPlayPlaylist,
}: {
  shelf: HomeShelf;
  currentVideoId: string | undefined;
  isMenuTarget: (item: HomeItem) => boolean;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
  onPlayAlbum: (item: HomeItem) => void;
  onPlayPlaylist: (playlistId: string) => void;
}) => (
  <section className="group/snap">
    <h2 className="text-xl font-bold">{shelf.title}</h2>
    <SnapRow>
      {shelf.items.map((item, index) => (
        <HomeCard
          key={itemKey(item, index)}
          item={item}
          playing={Boolean(item.videoId) && currentVideoId === item.videoId}
          menuOpen={isMenuTarget(item)}
          onOpen={() => onOpen(item)}
          onOpenMenu={(x, y) => onOpenMenu(item, x, y)}
          onPlayAlbum={() => onPlayAlbum(item)}
          onPlayPlaylist={() => {
            if (item.kind === "playlist" && item.playlistId) onPlayPlaylist(item.playlistId);
          }}
        />
      ))}
    </SnapRow>
  </section>
);


export const HomeCard = ({
  item,
  playing,
  menuOpen,
  onOpen,
  onOpenMenu,
  onPlayAlbum,
  onPlayPlaylist,
}: {
  item: HomeItem;
  playing: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onPlayAlbum: () => void;
  onPlayPlaylist: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = item.thumbnails?.[0]?.url;
  const isPlaylist = item.kind === "playlist" && Boolean(item.playlistId);
  const isAlbum = Boolean(albumOpenId(item));
  const canOpen =
    item.kind === "song"
      ? Boolean(item.videoId)
      : item.kind === "artist"
        ? Boolean(item.browseId)
        : item.kind === "album"
          ? isAlbum
          : Boolean(item.playlistId);

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (isPlaylist || (item.kind === "song" && item.videoId)) onOpenMenu(event.clientX, event.clientY);
      }}
      data-menu-open={menuOpen ? "true" : undefined}
      className="group w-36 shrink-0 sm:w-40"
    >
      <div
        className={cn(
          "relative overflow-hidden rounded-md bg-secondary",
          isVideoMedia(item.videoType) ? "aspect-video" : "aspect-square",
          playing && "ring-2 ring-accent"
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          disabled={!canOpen}
          aria-label={item.kind === "song" ? `Play ${item.title}` : `Open ${item.title}`}
          className="absolute inset-0 cursor-pointer disabled:cursor-default"
        >
          {thumbnailUrl && !failed ? (
            <img src={thumbnailUrl} alt="" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
            </span>
          )}
        </button>
        {isPlaylist || isAlbum ? (
          <span
            onClick={onOpen}
            className="pointer-events-none absolute inset-0 cursor-pointer opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-[menu-open=true]:pointer-events-auto group-data-[menu-open=true]:opacity-100"
          >
            {isPlaylist && (
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenMenu(rect.left, rect.bottom);
                }}
                className="pointer-events-none absolute top-1 right-1 group-hover:pointer-events-auto group-focus-within:pointer-events-auto group-data-[menu-open=true]:pointer-events-auto"
              >
                <IconButton
                  iconClass="icon-[solar--menu-dots-bold]"
                  label={`More options for ${item.title}`}
                  size="sm"
                  tone="ghost"
                  className="pointer-events-none text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.8)] group-hover:pointer-events-auto group-focus-within:pointer-events-auto group-data-[menu-open=true]:pointer-events-auto"
                />
              </span>
            )}
            <button
              type="button"
              aria-label={`Play ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                if (isAlbum) onPlayAlbum();
                else onPlayPlaylist();
              }}
              className="group/play pointer-events-none absolute right-1.5 bottom-1.5 grid size-10 cursor-pointer place-items-center text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.8)] group-hover:pointer-events-auto group-focus-within:pointer-events-auto group-data-[menu-open=true]:pointer-events-auto"
            >
              <RevealIcon grow iconClassName="icon-[solar--play-bold] text-2xl" />
            </button>
          </span>
        ) : (
          <span className={mediaScrimClass}>
            <RevealIcon
              grow={item.kind === "song"}
              interactive={item.kind === "song"}
              onClick={item.kind === "song" && canOpen ? onOpen : undefined}
              iconClassName={
                item.kind === "song" ? "icon-[solar--play-bold] text-2xl" : "icon-[solar--library-linear] text-2xl"
              }
            />
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={!canOpen}
        className="mt-2 block w-full cursor-pointer text-left disabled:cursor-default"
      >
        <span className="block truncate text-sm font-medium">{item.title}</span>
        {item.subtitle && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
            {item.explicit && <ExplicitBadge />}
            <span className="truncate">{item.subtitle}</span>
          </span>
        )}
      </button>
    </div>
  );
};
