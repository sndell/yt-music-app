import { useCallback, useRef, useState } from "react";
import { PyBridge } from "@/lib/api/bridge";
import type { PlaylistSummary, PlaylistDetails } from "@/lib/api/types";

export const usePlaylist = () => {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

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

  const fetchPlaylistItems = useCallback(async (playlistId: string): Promise<PlaylistDetails | null> => {
    const result = await PyBridge.getPlaylistItems(playlistId);
    return result.success ? result.data : null;
  }, []);

  return { playlists, isLoading, error, fetchPlaylists, fetchPlaylistItems };
};
