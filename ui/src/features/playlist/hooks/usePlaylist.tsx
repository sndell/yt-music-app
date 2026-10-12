import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { PyBridge } from "@/lib/api/bridge";
import type { PlaylistSummary } from "@/lib/api/types";

type PlaylistContextValue = {
  playlists: PlaylistSummary[];
  isLoading: boolean;
  error: string | null;
  fetchPlaylists: () => Promise<void>;
};

const PlaylistContext = createContext<PlaylistContextValue | null>(null);

export const PlaylistProvider = ({ children }: { children: ReactNode }) => {
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

  const value = useMemo(
    () => ({ playlists, isLoading, error, fetchPlaylists }),
    [playlists, isLoading, error, fetchPlaylists],
  );

  return <PlaylistContext.Provider value={value}>{children}</PlaylistContext.Provider>;
};

export const usePlaylist = () => {
  const value = useContext(PlaylistContext);
  if (!value) throw new Error("usePlaylist must be used within PlaylistProvider");
  return value;
};
