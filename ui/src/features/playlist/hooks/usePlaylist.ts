import { useCallback, useState } from "react";
import { PyBridge } from "@/lib/api/bridge";
import type { PlaylistSummary, PlaylistDetails } from "@/lib/api/types";

interface UsePlaylistState {
  playlists: PlaylistSummary[];
  currentPlaylist: PlaylistDetails | null;
  isLoading: boolean;
  error: string | null;
}

interface UsePlaylistReturn extends UsePlaylistState {
  fetchPlaylists: () => Promise<void>;
  fetchPlaylistItems: (playlistId: string) => Promise<PlaylistDetails | null>;
  clearError: () => void;
}

/**
 * Hook to manage playlist data from the Python backend
 */
export const usePlaylist = (): UsePlaylistReturn => {
  const [state, setState] = useState<UsePlaylistState>({
    playlists: [],
    currentPlaylist: null,
    isLoading: false,
    error: null,
  });

  const fetchPlaylists = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    const result = await PyBridge.getPlaylists();

    if (result.success) {
      setState((prev) => ({
        ...prev,
        playlists: result.data,
        isLoading: false,
      }));
    } else {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: result.error.message,
      }));
    }
  }, []);

  const fetchPlaylistItems = useCallback(async (playlistId: string): Promise<PlaylistDetails | null> => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    const result = await PyBridge.getPlaylistItems(playlistId);

    if (result.success) {
      setState((prev) => ({
        ...prev,
        currentPlaylist: result.data,
        isLoading: false,
      }));
      return result.data;
    } else {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: result.error.message,
      }));
      return null;
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    fetchPlaylists,
    fetchPlaylistItems,
    clearError,
  };
};
