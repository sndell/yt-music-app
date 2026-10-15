import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PlaylistSummary } from "@/lib/api/types";
import { useAddToPlaylist } from "@/features/playlist/hooks/useAddToPlaylist";
import { cn } from "@/util/cn";
import { useMenuPosition } from "./useMenuPosition";

export const panelWidth = 320;

const songCount = (count?: string) => {
  if (count == null) return null;
  const digits = count.replace(/,/g, "").trim();
  if (!digits) return null;
  const total = Number(digits);
  if (!Number.isInteger(total) || total < 0) return null;
  return `${total} ${total === 1 ? "song" : "songs"}`;
};

/**
 * The "Save to playlist" picker from YouTube Music: a row of recommended
 * playlists on top, then every owned playlist behind a search field. The
 * panel stays open when you let a playlist go so a song can go to several at
 * once. A pick adds the songs, a second pick removes them, and a row shows a
 * spinner while its request is queued or running.
 */
export const AddToPlaylistPanel = ({
  videoIds,
  playlists,
  recommended,
  recommendedPending,
  onNewPlaylist,
  className,
}: {
  /** The songs this picker adds or removes. */
  videoIds: string[];
  /** All owned playlists; already filtered by the caller. */
  playlists: PlaylistSummary[];
  /** Recency-scored subset, or null while still loading. */
  recommended: PlaylistSummary[] | null;
  /** True while the recommended ids are being fetched. */
  recommendedPending?: boolean;
  /** Opens the create-playlist dialog; omitted when creation is unavailable. */
  onNewPlaylist?: () => void;
  className?: string;
}) => {
  const { addedIds, pendingIds, toggle } = useAddToPlaylist(videoIds);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? playlists.filter((playlist) => playlist.title.toLowerCase().includes(needle)) : playlists),
    [playlists, needle],
  );
  const recommendedRows = (recommended ?? []).filter((playlist) =>
    playlists.some((row) => row.playlistId === playlist.playlistId),
  );

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      {recommendedRows.length > 0 ? (
        <div className="shrink-0 border-b border-primary/20 px-2.5 pt-2.5 pb-2">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-primary-dark">Recommended</p>
          <div className="scrollbar-thin flex gap-2 overflow-x-auto pb-0.5">
            {recommendedRows.map((playlist) => (
              <RecommendedChip
                key={playlist.playlistId}
                playlist={playlist}
                added={addedIds.has(playlist.playlistId)}
                pending={pendingIds.has(playlist.playlistId)}
                onToggle={() => toggle(playlist.playlistId)}
              />
            ))}
          </div>
        </div>
      ) : recommendedPending ? (
        <div className="shrink-0 border-b border-primary/20 px-2.5 py-2.5">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-primary-dark">Recommended</p>
          <div className="flex gap-2">
            {Array.from({ length: 4 }, (_, index) => (
              <span key={index} className="size-[3.25rem] shrink-0 animate-pulse rounded-md bg-primary-light" />
            ))}
          </div>
        </div>
      ) : null}

      <div className="px-2.5 pt-2 pb-1">
        <label className="flex items-center gap-1.5 rounded-lg bg-primary-light px-2 py-1.5 text-sm transition-[box-shadow] focus-within:ring-2 focus-within:ring-white/15">
          <span aria-hidden="true" className="shrink-0 text-base text-primary-dark">
            <span className="icon-[solar--magnifer-linear]" />
          </span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search playlists"
            className="w-full bg-transparent text-primary outline-none placeholder:text-primary-dark/70"
          />
        </label>
      </div>

      <div className="scrollbar-thin max-h-72 overflow-y-auto px-2.5 pb-1">
        {onNewPlaylist && (
          <button
            type="button"
            onClick={onNewPlaylist}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-1.5 pr-2.5 text-left transition-colors duration-150 hover:bg-white/10"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-light">
              <span aria-hidden="true" className="text-lg text-primary-dark">
                <span className="icon-[solar--add-linear]" />
              </span>
            </span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">New playlist</span>
          </button>
        )}
        {filtered.length === 0 ? (
          <p className="px-1.5 py-2 text-sm text-primary-dark">{needle ? "No matching playlists" : "No playlists yet"}</p>
        ) : (
          filtered.map((playlist) => (
            <PlaylistPickRow
              key={playlist.playlistId}
              playlist={playlist}
              added={addedIds.has(playlist.playlistId)}
              pending={pendingIds.has(playlist.playlistId)}
              onToggle={() => toggle(playlist.playlistId)}
            />
          ))
        )}
      </div>
    </div>
  );
};

const RecommendedChip = ({
  playlist,
  added,
  pending,
  onToggle,
}: {
  playlist: PlaylistSummary;
  added: boolean;
  pending: boolean;
  onToggle: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;

  return (
    <button
      type="button"
      title={playlist.title}
      disabled={pending}
      onClick={onToggle}
      className="group w-[3.9rem] shrink-0 cursor-pointer text-center disabled:cursor-default"
    >
      <span className="relative block aspect-square overflow-hidden rounded-md bg-primary-light">
        {thumbnailUrl && !failed ? (
          <img
            src={thumbnailUrl}
            alt=""
            draggable={false}
            onError={() => setFailed(true)}
            className="size-full object-cover transition-transform duration-200 group-hover:scale-105"
          />
        ) : (
          <span className="grid size-full place-items-center">
            <span aria-hidden="true" className="text-xl text-primary-dark">
              <span className="icon-[solar--music-note-linear]" />
            </span>
          </span>
        )}
        {pending ? (
          <span className="absolute inset-0 grid place-items-center rounded-md bg-black/60">
            <span aria-hidden="true" className="icon-[solar--loader-linear] animate-spin text-xl text-primary" />
          </span>
        ) : added ? (
          <span className="absolute inset-0 grid place-items-center rounded-md bg-black/60">
            <span aria-hidden="true" className="text-2xl text-success">
              <span className="icon-[solar--check-circle-bold]" />
            </span>
          </span>
        ) : null}
      </span>
      <span className="mt-1 block truncate text-xs text-primary-dark group-hover:text-primary">{playlist.title}</span>
    </button>
  );
};

const PlaylistPickRow = ({
  playlist,
  added,
  pending,
  onToggle,
}: {
  playlist: PlaylistSummary;
  added: boolean;
  pending: boolean;
  onToggle: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;
  const count = songCount(playlist.count);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={onToggle}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-1.5 pr-2.5 text-left transition-colors duration-150 hover:bg-white/10 disabled:cursor-default"
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
          <span aria-hidden="true" className="text-lg text-primary-dark">
            <span className="icon-[solar--music-note-linear]" />
          </span>
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-primary">{playlist.title}</span>
        {count && <span className="block truncate text-xs text-primary-dark">{count}</span>}
      </span>
      {pending ? (
        <span
          aria-hidden="true"
          className="icon-[solar--loader-linear] shrink-0 animate-spin text-lg text-primary-dark"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "shrink-0 text-lg transition-opacity duration-150",
            added ? "text-success opacity-100" : "text-primary-dark opacity-0 group-hover:opacity-100",
          )}
        >
          <span className={added ? "icon-[solar--check-circle-bold]" : "icon-[solar--add-linear]"} />
        </span>
      )}
    </button>
  );
};

/** Standalone floating variant for callers with no track menu to host them. */
export const AddToPlaylistMenu = ({
  x,
  y,
  onClose,
  ...panel
}: {
  x: number;
  y: number;
  onClose: () => void;
} & Omit<Parameters<typeof AddToPlaylistPanel>[0], "className">) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useMenuPosition(menuRef, x, y);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onCloseRef.current();
    };
    const onResize = () => onCloseRef.current();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ left: x, top: y, width: panelWidth }}
      onContextMenu={(event) => event.preventDefault()}      className="fixed z-50 overflow-hidden rounded-2xl bg-black py-1 shadow-[0_10px_28px_rgb(0_0_0/0.65)]"
    >
      <AddToPlaylistPanel {...panel} className="max-h-[70vh]" />
    </div>,
    document.body,
  );
};
