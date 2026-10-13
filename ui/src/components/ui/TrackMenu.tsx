import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistSummary } from "@/lib/api";
import { cn } from "@/util/cn";
import { MenuFlyout } from "./MenuFlyout";
import { announceMenuOpen, isInsideMenuFlyout, nextMenuId, onOtherMenuOpen } from "./menuDom";
import { useMenuPosition } from "./useMenuPosition";

const itemClass =
  "group flex w-full cursor-pointer items-center gap-2.5 px-2.5 py-2 text-left text-sm text-primary transition-colors duration-150 hover:bg-white/10";

const iconClass = "shrink-0 text-lg text-primary-dark transition-colors duration-150 group-hover:text-primary";

const chevronClass =
  "shrink-0 text-lg text-primary-dark transition-[color,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:text-primary";

const songCount = (count?: string) => {
  if (count == null) return null;
  const digits = count.replace(/,/g, "").trim();
  if (!digits) return null;
  const total = Number(digits);
  if (!Number.isInteger(total) || total < 0) return null;
  return `${total} ${total === 1 ? "song" : "songs"}`;
};

export const TrackMenu = ({
  x,
  y,
  onClose,
  onShuffle,
  onStartMix,
  onPlayNext,
  onAddToQueue,
  onAddToPlaylist,
  playlists = [],
}: {
  x: number;
  y: number;
  onClose: () => void;
  onShuffle?: () => void;
  onStartMix: () => void;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  /** When set, the menu offers an "Add to playlist" flyout of `playlists`. */
  onAddToPlaylist?: (playlistId: string) => void;
  /** Options for the "Add to playlist" flyout. */
  playlists?: PlaylistSummary[];
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [listAnchor, setListAnchor] = useState<DOMRect | null>(null);
  const [menuId] = useState(() => nextMenuId());

  const options = playlists.filter((playlist) => playlist.owned !== false && playlist.playlistId !== "LM");

  useMenuPosition(menuRef, x, y);

  const cancelClose = () => {
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => setListAnchor(null), 200);
  };

  const closeList = () => {
    cancelClose();
    setListAnchor(null);
  };

  const openList = (element: HTMLElement) => {
    cancelClose();
    setListAnchor(element.getBoundingClientRect());
  };

  useEffect(() => () => cancelClose(), []);

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    announceMenuOpen(menuId);
    return onOtherMenuOpen(menuId, () => onCloseRef.current());
  }, [menuId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) || isInsideMenuFlyout(event.target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node) || isInsideMenuFlyout(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const choose = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <>
      <div
        ref={menuRef}
        role="menu"
        style={{ left: x, top: y }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerLeave={scheduleClose}
        className="fixed z-50 w-48 origin-top-left overflow-hidden rounded-2xl bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] transition-[scale,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0"
      >
        {onShuffle && (
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => choose(onShuffle)}
            onPointerEnter={closeList}
          >
            <span className={`${iconClass} icon-[solar--shuffle-linear]`} />
            Shuffle
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onStartMix)}
          onPointerEnter={closeList}
        >
          <span className={`${iconClass} icon-[solar--soundwave-linear]`} />
          Start mix
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onPlayNext)}
          onPointerEnter={closeList}
        >
          <span className={`${iconClass} icon-[solar--playlist-minimalistic-line-duotone]`} />
          Play next
        </button>
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => choose(onAddToQueue)}
          onPointerEnter={closeList}
        >
          <span className={`${iconClass} icon-[solar--list-arrow-down-minimalistic-bold-duotone]`} />
          Add to queue
        </button>

        {onAddToPlaylist && (
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={listAnchor != null}
            className={cn(itemClass, listAnchor && "bg-white/10")}
            onClick={(event) => {
              if (!listAnchor) openList(event.currentTarget);
            }}
            onPointerEnter={(event) => openList(event.currentTarget)}
          >
            <span className={`${iconClass} icon-[solar--add-circle-linear]`} />
            <span className="min-w-0 flex-1 truncate">Add to playlist</span>
            <span className={`${chevronClass} icon-[solar--alt-arrow-right-linear]`} />
          </button>
        )}
      </div>

      {onAddToPlaylist && listAnchor && (
        <MenuFlyout
          anchor={listAnchor}
          width={272}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          <p className="px-3.5 pt-1.5 pb-1 text-xs font-medium uppercase tracking-wide text-primary-dark">
            Add to playlist
          </p>
          <div className="scrollbar-thin max-h-72 overflow-y-auto px-1 pb-1">
            {options.length === 0 ? (
              <p className="px-2.5 py-2 text-sm text-primary-dark">No playlists yet</p>
            ) : (
              options.map((playlist) => (
                <PlaylistOption
                  key={playlist.playlistId}
                  playlist={playlist}
                  onSelect={() => choose(() => onAddToPlaylist(playlist.playlistId))}
                />
              ))
            )}
          </div>
        </MenuFlyout>
      )}
    </>,
    document.body,
  );
};

const PlaylistOption = ({ playlist, onSelect }: { playlist: PlaylistSummary; onSelect: () => void }) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;
  const count = songCount(playlist.count);

  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-1.5 pr-2.5 text-left transition-colors duration-150 hover:bg-white/10"
    >
      {thumbnailUrl && !failed ? (
        <img
          src={thumbnailUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="size-9 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-light">
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-primary">{playlist.title}</span>
        {count && <span className="block truncate text-xs text-primary-dark">{count}</span>}
      </span>
      <span className="icon-[solar--add-circle-linear] shrink-0 text-lg text-primary-dark opacity-0 transition-opacity duration-150 group-hover:opacity-100" />
    </button>
  );
};
