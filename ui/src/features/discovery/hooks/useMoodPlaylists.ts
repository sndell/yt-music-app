import { useCallback, useEffect, useRef, useState } from "react";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import type { PlaylistSummary } from "@/lib/api/types";

export type MoodPlaylistsData = {
  /** Null until the first answer lands; empty when the category holds none. */
  playlists: PlaylistSummary[] | null;
  error: string | null;
  load: (forceRefresh?: boolean) => void;
};

/**
 * One mood or genre category's playlists, keyed by the category's own params
 * token. Python caches each category for a week, so a second open paints from
 * disk and refreshes behind it.
 */
export const useMoodPlaylists = (params: string): MoodPlaylistsData => {
  const [playlists, setPlaylists] = useState<PlaylistSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef(true);

  // A second category replaces the first, so the stale answer for the old
  // params is dropped instead of painted over the new one.
  useEffect(() => {
    currentRef.current = true;
    setPlaylists(null);
    setError(null);
    return () => {
      currentRef.current = false;
    };
  }, [params]);

  const load = useCallback(
    (forceRefresh = false) => {
      if (!params) return;
      if (forceRefresh) {
        void PyBridge.getMoodPlaylists(params, true).then((result) => {
          if (!currentRef.current) return;
          if (result.success) setPlaylists(result.data.playlists);
          else setError(result.error.message);
        });
        return;
      }
      void showCachedThenRefresh(
        (refresh) => PyBridge.getMoodPlaylists(params, refresh),
        (data) => setPlaylists(data.playlists),
        () => currentRef.current,
      ).then((result) => {
        if (result && !result.success) setError(result.error.message);
      });
    },
    [params],
  );

  useEffect(() => {
    load();
  }, [load]);

  return { playlists, error, load };
};
