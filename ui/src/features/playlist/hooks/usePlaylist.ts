import { useCallback, useState } from "react";
import { getPlaylistItems, getPlaylists } from "@/lib/api/bridge";

type UsePlaylistState = {
  playlists: GetPlaylistsResponse;
  isLoading: boolean;
  error: string | null;
};

type UsePlaylistReturn = UsePlaylistState & {
  fetchPlaylists: () => Promise<void>;
  fetchPlaylistItems: (playlistId: string) => Promise<void>;
};

/**
 * Hook to manage playlist data from the Python backend
 */
export const usePlaylist = (): UsePlaylistReturn => {
  const [state, setState] = useState<UsePlaylistState>({
    playlists: [],
    isLoading: false,
    error: null,
  });

  const fetchPlaylists = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    try {
      const playlists = await getPlaylists();
      setState({ playlists, isLoading: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch playlists";
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
    }
  }, []);

  const fetchPlaylistItems = useCallback(async (playlistId: string) => {
    try {
      await getPlaylistItems(playlistId);
      console.log("Playlist items fetched successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch playlist items";
      setState((prev) => ({ ...prev, isLoading: false, error: message }));
    }
  }, []);

  return {
    ...state,
    fetchPlaylists,
    fetchPlaylistItems,
  };
};

