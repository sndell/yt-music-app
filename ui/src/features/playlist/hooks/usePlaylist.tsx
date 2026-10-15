import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { PyBridge } from "@/lib/api/bridge";
import type { PlaylistItemRef, PlaylistPatch, PlaylistPrivacy, PlaylistSummary } from "@/lib/api/types";
import { useToast } from "@/components/ui/Toast";

/** Outcome of an add, including whether the songs were already there. */
export type AddToPlaylistResult = {
  ok: boolean;
  /** True when nothing changed because the songs were already in the playlist. */
  duplicate: boolean;
  /** YouTube Music's row ids for songs this call added. */
  setVideoIds: Record<string, string>;
};

type PlaylistContextValue = {
  playlists: PlaylistSummary[];
  isLoading: boolean;
  error: string | null;
  fetchPlaylists: () => Promise<void>;
  /** Loaded lazily when the add-to-playlist flyout opens; null until the first fetch. */
  recommendedPlaylists: PlaylistSummary[] | null;
  /** True while those ids are being fetched. */
  recommendedPending: boolean;
  fetchRecommendedPlaylists: () => Promise<PlaylistSummary[]>;
  /**
   * Add one or more songs to a playlist. Edits are serialized, so several
   * picks in a row are queued rather than raced. On failure `ok` is false.
   */
  addToPlaylist: (playlistId: string, videoIds: string[], duplicates?: boolean) => Promise<AddToPlaylistResult>;
  /** Remove one row per song, the picker's click-again toggle. Returns false on failure. */
  removeFromPlaylistVideo: (
    playlistId: string,
    videoIds: string[],
    setVideoIds?: Record<string, string>,
  ) => Promise<boolean>;
  /** Remove playlist rows. Returns false and reports the error on failure. */
  removeFromPlaylist: (playlistId: string, items: PlaylistItemRef[]) => Promise<boolean>;
  /** Re-add a possibly-removed song and try to move it back into place (the Undo toast action). */
  restorePlaylistItem: (playlistId: string, videoId: string, beforeSetVideoId: string | null) => Promise<boolean>;
  /** Apply any mix of title, description and privacy changes. Patches the sidebar entry. */
  editPlaylist: (playlistId: string, patch: PlaylistPatch) => Promise<boolean>;
  /** Delete an owned playlist and drop its sidebar entry. */
  deletePlaylist: (playlistId: string) => Promise<boolean>;
  /** Create a playlist, optionally with songs, and refresh the sidebar. Returns its id. */
  createPlaylist: (title: string, description: string, privacy: PlaylistPrivacy, videoIds: string[]) => Promise<string | null>;
  /** Like the playlist, or remove it from the account library again. */
  ratePlaylist: (playlistId: string, liked: boolean) => Promise<boolean>;
};

const PlaylistContext = createContext<PlaylistContextValue | null>(null);

/** Tells open playlist views that YouTube Music data for this playlist changed. */
const notifyPlaylistChanged = (playlistId: string) => {
  window.dispatchEvent(new CustomEvent("ytmusic-playlist-changed", { detail: { playlistId } }));
};

export const PlaylistProvider = ({ children }: { children: ReactNode }) => {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendedPlaylists, setRecommendedPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [recommendedPending, setRecommendedPending] = useState(false);
  const requestIdRef = useRef(0);
  /** True once a fetch has completed, so later refreshes never flash the loader. */
  const loadedOnceRef = useRef(false);
  // Playlists we created but the library endpoint has not reported yet. A fresh
  // playlist lags a few seconds there, so these rows are held across refetches
  // and dropped once the server list carries them.
  const pendingCreatesRef = useRef<PlaylistSummary[]>([]);
  const { showToast } = useToast();

  const fetchPlaylists = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    // Only the first load shows the sidebar loader. A refresh keeps the rows
    // that are already painted, so adding a playlist does not blink the panel
    // behind a spinner.
    if (!loadedOnceRef.current) setIsLoading(true);
    setError(null);

    const result = await PyBridge.getPlaylists();

    // Ignore stale responses (e.g., from HMR race conditions)
    if (requestId !== requestIdRef.current) return;

    loadedOnceRef.current = true;
    if (result.success) {
      const serverIds = new Set(result.data.map((playlist) => playlist.playlistId));
      // Keep the optimistic rows the server list does not have yet; drop the
      // ones it now reports so the real row (thumbnail, count) takes over.
      pendingCreatesRef.current = pendingCreatesRef.current.filter(
        (playlist) => !serverIds.has(playlist.playlistId),
      );
      setPlaylists([...pendingCreatesRef.current, ...result.data]);
    } else {
      setError(result.error.message);
    }
    setIsLoading(false);
  }, []);

  const fetchRecommendedPlaylists = useCallback(async () => {
    // The ranked ids are cheap for Python (reads a local stats file); mapping
    // them onto the playlist list the frontend already holds avoids another
    // YouTube library request on every flyout open.
    setRecommendedPending(true);
    try {
      const result = await PyBridge.getRecommendedPlaylists(4);
      const data = result.success ? result.data : { playlistIds: [] };
      const byId = new Map(playlists.map((playlist) => [playlist.playlistId, playlist]));
      const mapped = data.playlistIds.flatMap((playlistId) => {
        const playlist = byId.get(playlistId);
        return playlist ? [playlist] : [];
      });
      setRecommendedPlaylists(mapped);
      return mapped;
    } finally {
      setRecommendedPending(false);
    }
  }, [playlists]);

  // Playlist edits run one at a time. Picking several playlists quickly used
  // to fire overlapping writes at the same YouTube Music session and fail;
  // the queue holds each edit until the previous one has finished.
  const editChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const result = editChainRef.current.then(task, task);
    editChainRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }, []);

  const addToPlaylist = useCallback(
    (playlistId: string, videoIds: string[], duplicates = false) =>
      enqueue(async (): Promise<AddToPlaylistResult> => {
        const result = await PyBridge.addPlaylistItems(playlistId, videoIds, duplicates);
        if (!result.success) {
          showToast(result.error.message || "Could not add to the playlist", "error");
          return { ok: false, duplicate: false, setVideoIds: {} };
        }
        if (!result.data.duplicate) notifyPlaylistChanged(playlistId);
        return {
          ok: true,
          duplicate: Boolean(result.data.duplicate),
          setVideoIds: result.data.setVideoIds ?? {},
        };
      }),
    [enqueue, showToast],
  );

  const removeFromPlaylistVideo = useCallback(
    (playlistId: string, videoIds: string[], setVideoIds: Record<string, string> = {}) =>
      enqueue(async () => {
        const result = await PyBridge.removePlaylistVideos(playlistId, videoIds, setVideoIds);
        if (!result.success) {
          showToast(result.error.message || "Could not remove from the playlist", "error");
          return false;
        }
        notifyPlaylistChanged(playlistId);
        return true;
      }),
    [enqueue, showToast],
  );

  const removeFromPlaylist = useCallback(
    (playlistId: string, items: PlaylistItemRef[]) =>
      enqueue(async () => {
        const result = await PyBridge.removePlaylistItems(playlistId, items);
        if (!result.success) {
          showToast(result.error.message || "Could not remove from the playlist", "error");
          return false;
        }
        notifyPlaylistChanged(playlistId);
        return true;
      }),
    [enqueue, showToast],
  );

  const restorePlaylistItem = useCallback(
    (playlistId: string, videoId: string, beforeSetVideoId: string | null) =>
      enqueue(async () => {
        const addResult = await PyBridge.addPlaylistItems(playlistId, [videoId]);
        if (!addResult.success) {
          showToast(addResult.error.message || "Could not undo the removal", "error");
          return false;
        }
        const setVideoId = addResult.data.setVideoIds?.[videoId];
        if (setVideoId) {
          // beforeSetVideoId is the row the song sat behind; "" puts it at the end,
          // so a moved-back song can land in its exact spot either way.
          await PyBridge.movePlaylistItem(playlistId, setVideoId, beforeSetVideoId ?? "");
        }
        notifyPlaylistChanged(playlistId);
        return true;
      }),
    [enqueue, showToast],
  );

  const editPlaylist = useCallback(
    async (playlistId: string, patch: PlaylistPatch) => {
      const result = await PyBridge.editPlaylist(playlistId, patch);
      if (!result.success) {
        showToast(result.error.message || "Could not update the playlist", "error");
        return false;
      }
      if (patch.title != null || patch.description != null || patch.privacy != null) {
        const applyPatch = (playlist: PlaylistSummary) =>
          playlist.playlistId === playlistId
            ? {
                ...playlist,
                ...(patch.title != null ? { title: patch.title } : {}),
                ...(patch.description != null ? { description: patch.description } : {}),
              }
            : playlist;
        pendingCreatesRef.current = pendingCreatesRef.current.map(applyPatch);
        setPlaylists((current) => current.map(applyPatch));
      }
      if (patch.title != null || patch.description != null) showToast("Playlist updated");
      if (patch.privacy != null) showToast(`Playlist is now ${patch.privacy.toLowerCase()}`);
      notifyPlaylistChanged(playlistId);
      return true;
    },
    [showToast],
  );

  const deletePlaylist = useCallback(
    async (playlistId: string) => {
      const result = await PyBridge.deletePlaylist(playlistId);
      if (!result.success) {
        showToast(result.error.message || "Could not delete the playlist", "error");
        return false;
      }
      setPlaylists((current) => current.filter((playlist) => playlist.playlistId !== playlistId));
      pendingCreatesRef.current = pendingCreatesRef.current.filter(
        (playlist) => playlist.playlistId !== playlistId,
      );
      return true;
    },
    [showToast],
  );

  // The library endpoint reports a new playlist only after a few seconds, so
  // re-check a couple of times to swap the placeholder for the real row.
  const scheduleConfirmRefetch = useCallback(
    (playlistId: string) => {
      for (const delay of [1200, 3000, 6000]) {
        window.setTimeout(() => {
          // Nothing left to confirm once a fetch has dropped the placeholder.
          if (!pendingCreatesRef.current.some((playlist) => playlist.playlistId === playlistId)) return;
          void fetchPlaylists();
        }, delay);
      }
    },
    [fetchPlaylists],
  );

  const createPlaylist = useCallback(
    async (title: string, description: string, privacy: PlaylistPrivacy, videoIds: string[]) => {
      const result = await PyBridge.createPlaylist(title, description, privacy, videoIds);
      if (!result.success) {
        showToast(result.error.message || "Could not create the playlist", "error");
        return null;
      }
      const playlistId = result.data.playlistId;
      // Show the new playlist straight away. The library endpoint lags it, so
      // the row is held in pendingCreatesRef until a fetch confirms it.
      const placeholder: PlaylistSummary = {
        playlistId,
        title,
        description,
        thumbnails: [],
        count: String(videoIds.length),
        owned: true,
      };
      pendingCreatesRef.current = [
        placeholder,
        ...pendingCreatesRef.current.filter((playlist) => playlist.playlistId !== playlistId),
      ];
      setPlaylists((current) => [
        placeholder,
        ...current.filter((playlist) => playlist.playlistId !== playlistId),
      ]);
      scheduleConfirmRefetch(playlistId);
      return playlistId;
    },
    [scheduleConfirmRefetch, showToast],
  );

  const ratePlaylist = useCallback(
    async (playlistId: string, liked: boolean) => {
      const result = await PyBridge.ratePlaylist(playlistId, liked ? "LIKE" : "INDIFFERENT");
      if (!result.success) {
        showToast(result.error.message || "Could not update the playlist", "error");
        return false;
      }
      showToast(liked ? "Added playlist to your library" : "Removed playlist from your library");
      return true;
    },
    [showToast],
  );

  const value = useMemo(
    () => ({
      playlists,
      isLoading,
      error,
      fetchPlaylists,
      recommendedPlaylists,
      recommendedPending,
      fetchRecommendedPlaylists,
      addToPlaylist,
      removeFromPlaylistVideo,
      removeFromPlaylist,
      restorePlaylistItem,
      editPlaylist,
      deletePlaylist,
      createPlaylist,
      ratePlaylist,
    }),
    [
      playlists,
      isLoading,
      error,
      fetchPlaylists,
      recommendedPlaylists,
      recommendedPending,
      fetchRecommendedPlaylists,
      addToPlaylist,
      removeFromPlaylistVideo,
      removeFromPlaylist,
      restorePlaylistItem,
      editPlaylist,
      deletePlaylist,
      createPlaylist,
      ratePlaylist,
    ],
  );

  return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};

/** Playlist list and mutations for the sidebar and menus. */
export const usePlaylist = () => {
  const value = useContext(PlaylistContext);
  if (!value) throw new Error("usePlaylist must be used within PlaylistProvider");
  return value;
};
