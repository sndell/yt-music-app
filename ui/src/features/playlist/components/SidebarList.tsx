import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import type { PlaylistSummary } from "@/lib/api";
import { ReorderItem, ReorderList, consumeDragClick } from "@/components/ui/reorder";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { useEdgeFade } from "@/components/ui/useEdgeFade";
import { usePlayer } from "@/features/player";
import { moveItem, useOrderMap } from "@/lib/orderMap";
import { cn } from "@/util/cn";
import { usePlaylist } from "../hooks/usePlaylist.tsx";

const SIDEBAR_SCOPE = "sidebar:playlists";

const COLLAPSED_QUERY = "(max-width: 1023px)";

const collapsedSidebar = () => window.matchMedia(COLLAPSED_QUERY).matches;

type PreviewState = {
  playlistId: string;
  title: string;
  countLabel: string | null;
  anchor: PreviewAnchor;
};

export const SidebarList = () => {
  const { playlists, isLoading, error, fetchPlaylists } = usePlaylist();
  const orderMap = useOrderMap();
  const ordered = orderMap.apply(playlists, (playlist) => playlist.playlistId, SIDEBAR_SCOPE);
  const { playPlaylist, queuePlaylist } = usePlayer();
  const [, navigate] = useLocation();
  const listRef = useRef<HTMLDivElement>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const activeIdRef = useRef<string | null>(null);
  const closeTimer = useRef<number | null>(null);
  const playlistsRef = useRef(ordered);
  const menuOpenRef = useRef(false);
  const draggingRef = useRef(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [menu, setMenu] = useState<{ playlistId: string; x: number; y: number } | null>(null);
  playlistsRef.current = ordered;
  menuOpenRef.current = menu != null;

  const cancelClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  const hideNow = () => {
    cancelClose();
    activeIdRef.current = null;
    setPhase("closed");
  };

  const showAt = (playlist: PlaylistSummary, rect: DOMRect) => {
    if (!collapsedSidebar() || menuOpenRef.current || draggingRef.current) return;
    cancelClose();
    activeIdRef.current = playlist.playlistId;
    setPreview({
      playlistId: playlist.playlistId,
      title: playlist.title,
      countLabel: countLabel(playlist.count, "track"),
      anchor: measureAnchor(rect),
    });
    setPhase("open");
  };

  const scheduleHide = (id: string) => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      if (activeIdRef.current !== id) return;
      activeIdRef.current = null;
      setPhase("closing");
    }, 50);
  };

  const playlistFromPoint = (x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    const button = hit instanceof Element ? hit.closest<HTMLElement>("[data-playlist-id]") : null;
    if (!button || !listRef.current?.contains(button)) return null;
    const id = button.getAttribute("data-playlist-id");
    const playlist = playlistsRef.current.find((item) => item.playlistId === id);
    if (!playlist) return null;
    const art = button.querySelector("img, .size-10") ?? button;
    return { playlist, rect: art.getBoundingClientRect() };
  };

  const syncToPointer = () => {
    if (!collapsedSidebar()) {
      hideNow();
      return;
    }
    const found = playlistFromPoint(pointer.current.x, pointer.current.y);
    if (!found) {
      if (activeIdRef.current) scheduleHide(activeIdRef.current);
      return;
    }
    showAt(found.playlist, found.rect);
  };

  const syncRef = useRef(syncToPointer);
  syncRef.current = syncToPointer;

  useEdgeFade(listRef, {}, ordered.length);

  useEffect(() => {
    fetchPlaylists();
    const onAuthChanged = () => fetchPlaylists();
    window.addEventListener("ytmusic-auth-changed", onAuthChanged);
    return () => window.removeEventListener("ytmusic-auth-changed", onAuthChanged);
  }, [fetchPlaylists]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    let collapsed = collapsedSidebar();
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => syncRef.current());
    };
    const onResize = () => {
      const nextCollapsed = collapsedSidebar();
      const enteredCompact = nextCollapsed && !collapsed;
      collapsed = nextCollapsed;
      if (!nextCollapsed || enteredCompact) {
        hideNow();
        return;
      }
      if (!activeIdRef.current) return;
      const found = playlistFromPoint(pointer.current.x, pointer.current.y);
      if (!found || found.playlist.playlistId !== activeIdRef.current) {
        hideNow();
        return;
      }
      showAt(found.playlist, found.rect);
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
      list.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const rememberPointer = (event: PointerEvent) => {
    pointer.current = { x: event.clientX, y: event.clientY };
  };

  const showFromTarget = (target: EventTarget | null) => {
    const button = target instanceof Element ? target.closest<HTMLElement>("[data-playlist-id]") : null;
    if (!button || !listRef.current?.contains(button)) return;
    const id = button.getAttribute("data-playlist-id");
    const playlist = playlistsRef.current.find((item) => item.playlistId === id);
    if (!playlist) return;
    const art = button.querySelector("img, .size-10") ?? button;
    showAt(playlist, art.getBoundingClientRect());
  };

  const hideFromTarget = (target: EventTarget | null, related: EventTarget | null) => {
    const button = target instanceof Element ? target.closest("[data-playlist-id]") : null;
    if (!button) return;
    const next = related instanceof Element ? related.closest("[data-playlist-id]") : null;
    if (next && listRef.current?.contains(next)) return;
    const id = button.getAttribute("data-playlist-id");
    if (id) scheduleHide(id);
  };

  const onPointerMove = (event: PointerEvent) => {
    rememberPointer(event);
    showFromTarget(event.target);
  };

  const onPointerOut = (event: PointerEvent) => {
    hideFromTarget(event.target, event.relatedTarget);
  };

  const onFocus = (event: FocusEvent) => {
    showFromTarget(event.target);
  };

  const onBlur = (event: FocusEvent) => {
    hideFromTarget(event.target, event.relatedTarget);
  };

  return (
    <>
    <div
      ref={listRef}
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
      onFocus={onFocus}
      onBlur={onBlur}
      className="flex h-full flex-col gap-2 overflow-y-auto p-1.5 scrollbar-thin"
    >
      <div className="flex flex-1 flex-col gap-1">
        {error && (
          <div className="px-2 text-sm text-red-400 max-lg:grid max-lg:place-items-center max-lg:px-0">
            <span className="max-lg:hidden">{error}</span>
            <span className="icon-[solar--danger-triangle-linear] hidden text-lg max-lg:block" title={error} />
            <button
              type="button"
              onClick={fetchPlaylists}
              title="Reload"
              aria-label="Reload"
              className="mt-1 hidden cursor-pointer text-primary max-lg:block"
            >
              <span className="icon-[solar--refresh-linear] text-lg" />
            </button>
          </div>
        )}

        {isLoading && (
          <div className="grid flex-1 place-items-center py-8">
            <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
          </div>
        )}

        {playlists.length === 0 && !isLoading && !error && (
          <div className="grid h-full place-content-center py-4 text-center text-sm text-primary-dark">
            <span className="max-lg:hidden">
              Playlists will be shown here. Sign in from Settings.{" "}
            </span>
            <button
              type="button"
              onClick={fetchPlaylists}
              title="Reload"
              aria-label="Reload"
              className="cursor-pointer text-primary hover:underline"
            >
              <span className="lg:hidden">
                <span className="icon-[solar--refresh-linear] text-lg" />
              </span>
              <span className="hidden lg:inline">Reload</span>
            </button>
          </div>
        )}

        <ReorderList
          ids={ordered.map((playlist) => playlist.playlistId)}
          axis="y"
          onMove={(from, to) => {
            orderMap.commit(
              SIDEBAR_SCOPE,
              moveItem(ordered, from, to).map((playlist) => playlist.playlistId),
            );
          }}
          onActiveChange={(id) => {
            draggingRef.current = id != null;
            if (id) hideNow();
          }}
          overlay={(id) => {
            const playlist = ordered.find((item) => item.playlistId === id);
            return playlist ? <PlaylistGhost playlist={playlist} /> : null;
          }}
        >
          {ordered.map((playlist) => (
            <ReorderItem key={playlist.playlistId} id={playlist.playlistId}>
              <PlaylistSidebarItem
                playlist={playlist}
                active={phase === "open" && preview?.playlistId === playlist.playlistId}
                onOpen={() => navigate(`/playlist/${playlist.playlistId}`)}
                onOpenMenu={(x, y) => {
                  menuOpenRef.current = true;
                  hideNow();
                  setMenu({ playlistId: playlist.playlistId, x, y });
                }}
              />
            </ReorderItem>
          ))}
        </ReorderList>
      </div>
    </div>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            menuOpenRef.current = false;
            setMenu(null);
          }}
          onShuffle={() => void playPlaylist(menu.playlistId, "shuffle")}
          onStartMix={() => void playPlaylist(menu.playlistId, "mix")}
          onPlayNext={() => void queuePlaylist(menu.playlistId, "next")}
          onAddToQueue={() => void queuePlaylist(menu.playlistId, "end")}
        />
      )}
      {phase !== "closed" && preview && (
        <PlaylistPreview
          title={preview.title}
          countLabel={preview.countLabel}
          anchor={preview.anchor}
          phase={phase}
          onClosed={() => {
            if (activeIdRef.current == null) setPhase("closed");
          }}
        />
      )}
    </>
  );
};

const countLabel = (count: string | null | undefined, noun: "song" | "track"): string | null => {
  if (count == null) return null;
  const digits = count.replace(/,/g, "").trim();
  if (digits === "") return null;
  const total = Number(digits);
  if (!Number.isInteger(total) || total < 0) return null;
  const word = total === 1 ? noun : `${noun}s`;
  return `${total} ${word}`;
};

type PreviewAnchor = {
  top: number;
  left: number;
};

const measureAnchor = (rect: DOMRect): PreviewAnchor => {
  const center = rect.top + rect.height / 2;
  const half = 22;
  return {
    top: Math.min(Math.max(center, 8 + half), window.innerHeight - 8 - half),
    left: rect.right + 6,
  };
};

const PlaylistSidebarItem = ({
  playlist,
  active,
  onOpen,
  onOpenMenu,
}: {
  playlist: PlaylistSummary;
  active: boolean;
  onOpen: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;
  const songsLabel = countLabel(playlist.count, "song");

  return (
    <button
      type="button"
      data-playlist-id={playlist.playlistId}
      onClick={() => {
        if (consumeDragClick()) return;
        onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenMenu(event.clientX, event.clientY);
      }}
      aria-label={playlist.title}
      className={cn(
        "flex w-full min-w-0 cursor-grab items-center gap-2 rounded-lg p-1.5 text-left text-sm text-primary-dark lg:transition-colors hover:bg-primary-light hover:text-primary max-lg:justify-center max-lg:hover:bg-transparent",
        active && "max-lg:bg-primary-light max-lg:text-primary",
      )}
    >
      {thumbnailUrl && !failed ? (
        <img
          src={thumbnailUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="size-10 shrink-0 rounded-md object-cover"
        />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-primary-light">
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        </div>
      )}
      <span className="hidden min-w-0 flex-1 flex-col lg:flex">
        <span className="truncate">{playlist.title}</span>
        {songsLabel && <span className="truncate text-xs text-primary-dark">{songsLabel}</span>}
      </span>
    </button>
  );
};

const PlaylistGhost = ({ playlist }: { playlist: PlaylistSummary }) => {
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;
  const songsLabel = countLabel(playlist.count, "song");
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-lg bg-primary-light p-1.5 text-left text-sm text-primary shadow-[0_16px_40px_rgba(0,0,0,0.45)] ring-1 ring-white/15 max-lg:justify-center">
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" draggable={false} className="size-10 shrink-0 rounded-md object-cover" />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-md bg-primary">
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        </div>
      )}
      <span className="hidden min-w-0 flex-1 flex-col lg:flex">
        <span className="truncate">{playlist.title}</span>
        {songsLabel && <span className="truncate text-xs text-primary-dark">{songsLabel}</span>}
      </span>
    </div>
  );
};

const PlaylistPreview = ({
  title,
  countLabel,
  anchor,
  phase,
  onClosed,
}: {
  title: string;
  countLabel: string | null;
  anchor: PreviewAnchor;
  phase: "open" | "closing";
  onClosed: () => void;
}) => {
  const [shown, setShown] = useState(false);
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;

  useLayoutEffect(() => {
    if (phase !== "open") {
      setShown(false);
      return;
    }
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "closing") return;
    const timeout = window.setTimeout(() => onClosedRef.current(), 180);
    return () => window.clearTimeout(timeout);
  }, [phase]);

  return createPortal(
    <div
      role="tooltip"
      style={{ top: anchor.top, left: anchor.left }}
      className={cn(
        "pointer-events-none fixed z-50 w-max max-w-56 origin-left -translate-y-1/2 rounded-md bg-black px-2.5 py-1.5 text-left shadow-[0_8px_20px_rgb(0_0_0/0.55)] transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]",
        shown ? "scale-100 opacity-100" : "scale-95 opacity-0",
      )}
    >
      <span className="block truncate text-sm font-medium text-primary">{title}</span>
      {countLabel && <span className="block truncate text-xs text-primary-dark">{countLabel}</span>}
    </div>,
    document.body,
  );
};
