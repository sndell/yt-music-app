import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import type { PlaylistDetails, PlaylistSummary } from "@/lib/api";
import { PyBridge } from "@/lib/api";
import { ReorderItem, ReorderList, consumeDragClick } from "@/components/ui/reorder";
import { PlaylistMenu } from "@/components/ui/PlaylistMenu";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { EditPlaylistDialog } from "@/components/ui/EditPlaylistDialog";
import { useEdgeFade } from "@/components/ui/useEdgeFade";
import { OverlayScroll } from "@/components/ui/OverlayScroll";
import { useToast } from "@/components/ui/Toast";
import { usePlayer } from "@/features/player";
import { moveItem, orderFreshLast, pinFirst, useOrderMap } from "@/lib/orderMap";
import { cn } from "@/util/cn";
import { usePlaylist } from "../hooks/usePlaylist.tsx";

const SIDEBAR_SCOPE = "sidebar:playlists";

/** Liked Music is pinned to the top of the sidebar and cannot be reordered. */
const PINNED_PLAYLIST_ID = "LM";

const COLLAPSED_QUERY = "(max-width: 1023px)";

const collapsedSidebar = () => window.matchMedia(COLLAPSED_QUERY).matches;

type PreviewState = {
  playlistId: string;
  title: string;
  countLabel: string | null;
  anchor: PreviewAnchor;
};

export const SidebarList = () => {
  const { playlists, isLoading, error, fetchPlaylists, createPlaylist, editPlaylist, deletePlaylist } = usePlaylist();
  const { showToast } = useToast();
  const orderMap = useOrderMap();
  const applyOrderMap = orderMap.apply;
  // Liked Music is pinned to the panel's first row: keep it there even if a
  // saved order from before this rule lists another playlist ahead of it.
  // Memoized so `ordered` keeps its identity unless the list or order changes.
  const ordered = useMemo(
    () =>
      pinFirst(
        applyOrderMap(playlists, (playlist) => playlist.playlistId, SIDEBAR_SCOPE),
        (playlist) => playlist.playlistId,
        PINNED_PLAYLIST_ID,
      ),
    [applyOrderMap, playlists],
  );
  const { playPlaylist, queuePlaylist, trueShufflePlaylist } = usePlayer();
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
  const [creating, setCreating] = useState(false);
  /** Details of the playlist being edited, loaded before the dialog opens so its
   * visibility field shows the real value instead of a guess. */
  const [editing, setEditing] = useState<PlaylistDetails | null>(null);
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

  // A freshly created playlist belongs at the bottom of the panel. The saved
  // order map pins ids, so a new one has to be written after the rest once;
  // without that, the next fetch would place it by the endpoint's order.
  // Liked Music stays pinned above everything: the panel's first row, always.
  const seenIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = ordered.map((playlist) => playlist.playlistId);
    if (ids.length === 0) return;
    const seen = seenIdsRef.current;
    if (seen == null) {
      seenIdsRef.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => id !== PINNED_PLAYLIST_ID && !seen.has(id));
    if (fresh.length === 0) return;
    ids.forEach((id) => seen.add(id));
    orderMap.commit(SIDEBAR_SCOPE, orderFreshLast(ids, PINNED_PLAYLIST_ID, fresh));
  }, [ordered, orderMap]);

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

  /**
   * Read the playlist before opening the dialog: the sidebar summary has no
   * visibility, and guessing it would show the user the wrong setting.
   */
  const openEditor = (playlistId: string) => {
    void PyBridge.getPlaylistItems(playlistId, false).then((result) => {
      if (!result.success) {
        showToast(result.error.message || "Could not open the playlist", "error");
        return;
      }
      setEditing(result.data);
    });
  };

  return (
    <>
    <OverlayScroll
      viewportRef={listRef}
      className="h-full"
      viewportClassName="flex flex-col gap-2 overflow-y-auto p-1.5"
      onPointerMove={onPointerMove}
      onPointerOut={onPointerOut}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="flex h-9 items-center justify-between pl-2.5 pr-1.5 max-lg:justify-center max-lg:pl-0 max-lg:pr-0">
        <span className="truncate text-xs font-medium uppercase tracking-wide text-primary-dark max-lg:hidden">
          Playlists
        </span>
        <button
          type="button"
          title="New playlist"
          aria-label="New playlist"
          onClick={() => setCreating(true)}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-base text-primary-dark transition-colors hover:bg-primary-light hover:text-primary max-lg:size-9"
        >
          <span className="icon-[solar--add-linear]" />
        </button>
      </div>
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

        {isLoading && playlists.length === 0 && (
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
        >
          {ordered.map((playlist) => {
            const pinned = playlist.playlistId === PINNED_PLAYLIST_ID;
            return (
              <ReorderItem
                key={playlist.playlistId}
                id={playlist.playlistId}
                disabled={pinned ? { draggable: true, droppable: true } : false}
              >
                <PlaylistSidebarItem
                  playlist={playlist}
                  active={phase === "open" && preview?.playlistId === playlist.playlistId}
                  menuOpen={menu?.playlistId === playlist.playlistId}
                  onOpen={() => navigate(`/playlist/${playlist.playlistId}`)}
                  onOpenMenu={(x, y) => {
                    menuOpenRef.current = true;
                    hideNow();
                    setMenu({ playlistId: playlist.playlistId, x, y });
                  }}
                />
              </ReorderItem>
            );
          })}
        </ReorderList>
      </div>
    </OverlayScroll>
      {menu && (
        <PlaylistMenu
          x={menu.x}
          y={menu.y}
          onClose={() => {
            menuOpenRef.current = false;
            setMenu(null);
          }}
          onShuffle={() => void playPlaylist(menu.playlistId, "shuffle")}
          onTrueShuffle={() => void trueShufflePlaylist(menu.playlistId)}
          onStartMix={() => void playPlaylist(menu.playlistId, "mix")}
          onPlayNext={() => void queuePlaylist(menu.playlistId, "next")}
          onAddToQueue={() => void queuePlaylist(menu.playlistId, "end")}
          onEdit={
            menu.playlistId !== PINNED_PLAYLIST_ID &&
            playlists.find((playlist) => playlist.playlistId === menu.playlistId)?.owned !== false
              ? () => {
                  const playlistId = menu.playlistId;
                  setMenu(null);
                  menuOpenRef.current = false;
                  openEditor(playlistId);
                }
              : undefined
          }
        />
      )}
      {editing && (
        <EditPlaylistDialog
          initialTitle={editing.title}
          initialDescription={editing.description ?? ""}
          initialPrivacy={editing.privacy ?? "PRIVATE"}
          onSubmit={async (patch) => {
            const playlistId = editing.id;
            const ok = await editPlaylist(playlistId, {
              ...(patch.title !== editing.title ? { title: patch.title } : {}),
              ...(patch.description !== (editing.description ?? "") ? { description: patch.description } : {}),
              ...(patch.privacy !== editing.privacy ? { privacy: patch.privacy } : {}),
            });
            if (ok) setEditing(null);
            return ok;
          }}
          onDelete={async () => {
            const ok = await deletePlaylist(editing.id);
            if (ok) setEditing(null);
            return ok;
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {creating && (
        <CreatePlaylistDialog
          onCancel={() => setCreating(false)}
          onSubmit={async (title, description, privacy) => {
            const playlistId = await createPlaylist(title, description, privacy, []);
            if (playlistId) {
              setCreating(false);
              navigate(`/playlist/${playlistId}`);
            }
            return playlistId;
          }}
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
  menuOpen = false,
  onOpen,
  onOpenMenu,
}: {
  playlist: PlaylistSummary;
  active: boolean;
  /** Keeps the row in its hover state while its context menu is open. */
  menuOpen?: boolean;
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
      data-menu-open={menuOpen ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-lg p-1.5 text-left text-sm text-primary-dark lg:transition-colors hover:bg-primary-light hover:text-primary max-lg:justify-center max-lg:hover:bg-transparent",
        "cursor-pointer",
        "data-[menu-open=true]:bg-primary-light data-[menu-open=true]:text-primary max-lg:data-[menu-open=true]:bg-transparent",
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
