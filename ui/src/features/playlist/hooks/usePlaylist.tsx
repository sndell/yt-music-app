import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { PyBridge } from "@/lib/api/bridge";
import type { PlaylistPrivacy, PlaylistSummary } from "@/lib/api/types";
import { useToast } from "@/components/ui/Toast";

type PlaylistContextValue = {
  playlists: PlaylistSummary[];
  isLoading: boolean;
  error: string | null;
  fetchPlaylists: () => Promise<void>;
  /** Add a song to a playlist. Returns false and reports the error on failure. */
  addToPlaylist: (playlistId: string, videoId: string) => Promise<boolean>;
  /** Rename a playlist and patch the sidebar entry. */
  renamePlaylist: (playlistId: string, title: string) => Promise<boolean>;
  /** Change a playlist's visibility. */
  setPlaylistPrivacy: (playlistId: string, privacy: PlaylistPrivacy) => Promise<boolean>;
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
  const requestIdRef = useRef(0);
  const { showToast } = useToast();

  const fetchPlaylists = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    const result = await PyBridge.getPlaylists();

    // Ignore stale responses (e.g., from HMR race conditions)
    if (requestId !== requestIdRef.current) return;

    if (result.success) {
      setPlaylists(result.data);
    } else {
      setError(result.error.message);
    }
    setIsLoading(false);
  }, []);

  const addToPlaylist = useCallback(
    async (playlistId: string, videoId: string) => {
      const result = await PyBridge.addPlaylistItems(playlistId, [videoId]);
      if (!result.success) {
        showToast(result.error.message || "Could not add to the playlist", "error");
        return false;
      }
      const title = playlists.find((playlist) => playlist.playlistId === playlistId)?.title;
      showToast(title ? `Added to ${title}` : "Added to playlist");
      notifyPlaylistChanged(playlistId);
      return true;
    },
    [playlists, showToast],
  );

  const renamePlaylist = useCallback(
    async (playlistId: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return false;
      const result = await PyBridge.renamePlaylist(playlistId, trimmed);
      if (!result.success) {
        showToast(result.error.message || "Could not rename the playlist", "error");
        return false;
      }
      setPlaylists((current) =>
        current.map((playlist) => (playlist.playlistId === playlistId ? { ...playlist, title: trimmed } : playlist)),
      );
      showToast("Playlist renamed");
      notifyPlaylistChanged(playlistId);
      return true;
    },
    [showToast],
  );

  const setPlaylistPrivacy = useCallback(
    async (playlistId: string, privacy: PlaylistPrivacy) => {
      const result = await PyBridge.setPlaylistPrivacy(playlistId, privacy);
      if (!result.success) {
        showToast(result.error.message || "Could not change visibility", "error");
        return false;
      }
      showToast(`Playlist is now ${privacy.toLowerCase()}`);
      notifyPlaylistChanged(playlistId);
      return true;
    },
    [showToast],
  );

  const value = useMemo(
    () => ({ playlists, isLoading, error, fetchPlaylists, addToPlaylist, renamePlaylist, setPlaylistPrivacy }),
    [playlists, isLoading, error, fetchPlaylists, addToPlaylist, renamePlaylist, setPlaylistPrivacy],
  );

  return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};

/** Playlist list and mutations for the sidebar and menus. */
export const usePlaylist = () => {
  const value = useContext(PlaylistContext);
  if (!value) throw new Error("usePlaylist must be used within PlaylistProvider");
  return value;
};
