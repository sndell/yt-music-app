import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PyBridge } from "@/lib/api";
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

/** One removed song and the row it should be put back behind. */
export type PlaylistRestore = {
  videoId: string;
  /** The row the song sat behind, or null when it was the last one. */
  beforeSetVideoId: string | null;
};

/**
 * What one playlist edit changed.
 *
 * `patch` holds header fields the caller already applied, so a view can show
 * them without reading the playlist again. `tracksChanged` is set when the song
 * list moved, which is the only case that needs a re-read.
 */
export type PlaylistChangedDetail = {
  playlistId: string;
  tracksChanged?: boolean;
  patch?: PlaylistPatch;
};

/** YouTube Music reports a playlist's size as a formatted string ("1,204"). */
const parseCount = (count: string | undefined): number | null => {
  if (count == null) return null;
  const digits = count.replace(/,/g, "").trim();
  if (digits === "") return null;
  const total = Number(digits);
  return Number.isInteger(total) && total >= 0 ? total : null;
};

/** A size this session's edits produced, keyed by playlist id. */
type CountOverrides = Record<string, number>;

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
  /**
   * Put removed songs back, each before the row it used to sit behind. One
   * request adds them all and one write later moves them, so an undo of many
   * songs is not a burst of playlist reads. Returns false on failure.
   */
  restorePlaylistItems: (playlistId: string, items: PlaylistRestore[]) => Promise<boolean>;
  /**
   * The size to show for a playlist. This session's edits outrank the payload
   * the view holds, so an add or removal lands before any refetch does.
   *
   * The library list and the playlist header report the same size for every
   * playlist the user owns, and only an owned playlist can be edited, so one
   * override fits both without the two counts disagreeing.
   */
  displayCount: (playlistId: string | undefined, serverCount: number) => number;
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
const notifyPlaylistChanged = (playlistId: string, detail: Omit<PlaylistChangedDetail, "playlistId"> = {}) => {
  window.dispatchEvent(new CustomEvent("ytmusic-playlist-changed", { detail: { playlistId, ...detail } }));
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
  // Sizes this session's own edits produced. An entry is dropped again once a
  // library read that began after the edit reports the playlist, so the
  // server's own number takes back over instead of the two disagreeing.
  const [countOverrides, setCountOverrides] = useState<CountOverrides>({});
  const writeSeqRef = useRef(0);
  const writeSeqByPlaylistRef = useRef<Record<string, number>>({});
  // The library list as of the last render, so bumpCount can read a playlist's
  // server size without taking a dependency on the list itself.
  const playlistsRef = useRef(playlists);
  useEffect(() => {
    playlistsRef.current = playlists;
  }, [playlists]);
  const { showToast } = useToast();

  /**
   * Record the size an edit produced. The override outranks the server's own
   * count until a later library read confirms it, which is what keeps "12
   * songs" from going back to 11 while YouTube catches up.
   */
  const bumpCount = useCallback((playlistId: string, delta: number) => {
    if (!playlistId || delta === 0) return;
    writeSeqByPlaylistRef.current[playlistId] = ++writeSeqRef.current;
    setCountOverrides((current) => {
      const known =
        current[playlistId] ??
        parseCount(playlistsRef.current.find((playlist) => playlist.playlistId === playlistId)?.count);
      if (known == null) return current;
      const count = Math.max(0, known + delta);
      return current[playlistId] === count ? current : { ...current, [playlistId]: count };
    });
  }, []);

  const displayCount = useCallback(
    (playlistId: string | undefined, serverCount: number) =>
      (playlistId != null ? countOverrides[playlistId] : undefined) ?? serverCount,
    [countOverrides],
  );

  // The sidebar row, the hover preview, the library card and the picker row all
  // read this one list, so applying the override here is the only place an edit
  // has to land for every count on screen to agree.
  const playlistsWithCounts = useMemo(() => {
    if (Object.keys(countOverrides).length === 0) return playlists;
    return playlists.map((playlist) => {
      const base = parseCount(playlist.count);
      if (base == null) return playlist;
      const count = String(displayCount(playlist.playlistId, base));
      return playlist.count === count ? playlist : { ...playlist, count };
    });
  }, [playlists, countOverrides, displayCount]);

  const fetchPlaylists = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    // Sizes are reconciled against the moment the read began, not the moment it
    // lands: an edit made while it was in flight is newer than its answer.
    const readSeq = writeSeqRef.current;
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
      // This read is the newer word on every playlist it started after, so
      // those local sizes retire and the library's own numbers take over.
      setCountOverrides((current) => {
        let next: CountOverrides | null = null;
        for (const playlistId of Object.keys(current)) {
          if ((writeSeqByPlaylistRef.current[playlistId] ?? 0) > readSeq) continue;
          next ??= { ...current };
          delete next[playlistId];
        }
        return next ?? current;
      });
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
      const byId = new Map(playlistsWithCounts.map((playlist) => [playlist.playlistId, playlist]));
      const mapped = data.playlistIds.flatMap((playlistId) => {
        const playlist = byId.get(playlistId);
        return playlist ? [playlist] : [];
      });
      setRecommendedPlaylists(mapped);
      return mapped;
    } finally {
      setRecommendedPending(false);
    }
  }, [playlistsWithCounts]);

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
        if (!result.data.duplicate) {
          // The ids YouTube reported are the rows that landed, so the size
          // follows them rather than the ids the caller hoped would go in.
          bumpCount(playlistId, Object.keys(result.data.setVideoIds ?? {}).length || videoIds.length);
          notifyPlaylistChanged(playlistId, { tracksChanged: true });
        }
        return {
          ok: true,
          duplicate: Boolean(result.data.duplicate),
          setVideoIds: result.data.setVideoIds ?? {},
        };
      }),
    [enqueue, showToast, bumpCount],
  );

  const removeFromPlaylistVideo = useCallback(
    (playlistId: string, videoIds: string[], setVideoIds: Record<string, string> = {}) =>
      enqueue(async () => {
        const result = await PyBridge.removePlaylistVideos(playlistId, videoIds, setVideoIds);
        if (!result.success) {
          showToast(result.error.message || "Could not remove from the playlist", "error");
          return false;
        }
        // YouTube answers with how many rows it actually took, which is the
        // truth when the caller could not name every row it meant.
        bumpCount(playlistId, -(result.data.removed ?? videoIds.length));
        notifyPlaylistChanged(playlistId, { tracksChanged: true });
        return true;
      }),
    [enqueue, showToast, bumpCount],
  );

  const removeFromPlaylist = useCallback(
    (playlistId: string, items: PlaylistItemRef[]) =>
      enqueue(async () => {
        const result = await PyBridge.removePlaylistItems(playlistId, items);
        if (!result.success) {
          showToast(result.error.message || "Could not remove from the playlist", "error");
          return false;
        }
        // The playlist view drops the rows before this call and rolls them back
        // if it fails, so it must not be re-read here: a read that lands before
        // YouTube registers the edit would paint the removed rows again.
        bumpCount(playlistId, -items.length);
        return true;
      }),
    [enqueue, showToast, bumpCount],
  );

  const restorePlaylistItems = useCallback(
    (playlistId: string, items: PlaylistRestore[]) =>
      enqueue(async () => {
        if (items.length === 0) return true;
        // One add for the whole set, then a move per song back to its old
        // place. Adding them one at a time would re-read the playlist for each.
        const addResult = await PyBridge.addPlaylistItems(
          playlistId,
          items.map((item) => item.videoId),
          true,
        );
        if (!addResult.success) {
          showToast(addResult.error.message || "Could not undo the removal", "error");
          return false;
        }
        const setVideoIds = addResult.data.setVideoIds ?? {};
        for (const item of items) {
          const setVideoId = setVideoIds[item.videoId];
          if (!setVideoId) continue;
          // beforeSetVideoId is the row the song sat behind; "" puts it at the end,
          // so a moved-back song can land in its exact spot either way.
          await PyBridge.movePlaylistItem(playlistId, setVideoId, item.beforeSetVideoId ?? "");
        }
        bumpCount(playlistId, Object.keys(setVideoIds).length || items.length);
        notifyPlaylistChanged(playlistId, { tracksChanged: true });
        return true;
      }),
    [enqueue, showToast, bumpCount],
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
      // Nothing about the songs moved, so a view can show the new title,
      // description and visibility without reading the playlist again.
      notifyPlaylistChanged(playlistId, {
        patch: {
          ...(patch.title != null ? { title: patch.title } : {}),
          ...(patch.description != null ? { description: patch.description } : {}),
          ...(patch.privacy != null ? { privacy: patch.privacy } : {}),
        },
      });
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
      delete writeSeqByPlaylistRef.current[playlistId];
      setCountOverrides((current) => {
        if (!(playlistId in current)) return current;
        const next = { ...current };
        delete next[playlistId];
        return next;
      });
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
      playlists: playlistsWithCounts,
      isLoading,
      error,
      fetchPlaylists,
      recommendedPlaylists,
      recommendedPending,
      fetchRecommendedPlaylists,
      addToPlaylist,
      removeFromPlaylistVideo,
      removeFromPlaylist,
      restorePlaylistItems,
      displayCount,
      editPlaylist,
      deletePlaylist,
      createPlaylist,
      ratePlaylist,
    }),
    [
      playlistsWithCounts,
      isLoading,
      error,
      fetchPlaylists,
      recommendedPlaylists,
      recommendedPending,
      fetchRecommendedPlaylists,
      addToPlaylist,
      removeFromPlaylistVideo,
      removeFromPlaylist,
      restorePlaylistItems,
      displayCount,
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
