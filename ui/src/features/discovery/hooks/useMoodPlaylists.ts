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
  // A second category replaces the first, so an answer for the old params is
  // dropped instead of painted over the new one. The counter is read at resolve
  // time; a boolean flag cannot guard this, because the cleanup that cleared it
  // ran before the new params' effect set it back, and both happen in the commit
  // the old request is still in flight across.
  const requestIdRef = useRef(0);

  // A new category starts empty, and bumping here retires an in-flight read for
  // the params that just left even when the new params trigger no read.
  useEffect(() => {
    requestIdRef.current += 1;
    setPlaylists(null);
    setError(null);
  }, [params]);

  const load = useCallback(
    (forceRefresh = false) => {
      if (!params) return;
      const requestId = ++requestIdRef.current;
      // A retry has to be able to take the error down again, or the error card
      // outlives the rows the retry fetched and hides them.
      setError(null);
      if (forceRefresh) {
        void PyBridge.getMoodPlaylists(params, true).then((result) => {
          if (requestId !== requestIdRef.current) return;
          if (result.success) setPlaylists(result.data.playlists);
          else setError(result.error.message);
        });
        return;
      }
      void showCachedThenRefresh(
        (refresh) => PyBridge.getMoodPlaylists(params, refresh),
        (data) => {
          if (requestId === requestIdRef.current) setPlaylists(data.playlists);
        },
        () => requestId === requestIdRef.current,
      ).then((result) => {
        if (result && !result.success && requestId === requestIdRef.current) setError(result.error.message);
      });
    },
    [params],
  );

  useEffect(() => {
    load();
  }, [load]);

  return { playlists, error, load };
};
