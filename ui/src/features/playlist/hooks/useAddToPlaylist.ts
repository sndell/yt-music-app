import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { usePlaylist } from "./usePlaylist.tsx";

/**
 * Drives one open "Add to playlist" picker for a fixed set of songs.
 *
 * A click adds the songs; a second click removes them. A pick that finds the
 * songs already in a playlist offers to add them again anyway. Requests are
 * serialized inside usePlaylist, and a playlist with a request queued or
 * running sits in pendingIds so its row can show a spinner.
 */
export const useAddToPlaylist = (videoIds: string[]) => {
  const { addToPlaylist, removeFromPlaylistVideo, playlists } = usePlaylist();
  const { showToast } = useToast();
  const [addedIds, setAddedIds] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const addedRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Set<string>>(new Set());
  // Row ids from songs added here, so removing them again hits the exact rows
  // instead of re-reading the playlist. Empty for songs that were already there.
  const setVideoIdsRef = useRef<Map<string, Record<string, string>>>(new Map());

  const titleOf = useCallback(
    (playlistId: string) => playlists.find((playlist) => playlist.playlistId === playlistId)?.title,
    [playlists],
  );

  const markAdded = useCallback((playlistId: string, setVideoIds?: Record<string, string>) => {
    if (setVideoIds) setVideoIdsRef.current.set(playlistId, setVideoIds);
    addedRef.current.add(playlistId);
    setAddedIds([...addedRef.current]);
  }, []);

  // Add the songs even though they are already there. The "Add anyway" button
  // on the duplicate toast calls this.
  const forceAdd = useCallback(
    (playlistId: string) => {
      if (pendingRef.current.has(playlistId)) return;
      pendingRef.current.add(playlistId);
      setPendingIds([...pendingRef.current]);
      void (async () => {
        try {
          const result = await addToPlaylist(playlistId, videoIds, true);
          if (!result.ok) return;
          markAdded(playlistId, result.setVideoIds);
          const title = titleOf(playlistId);
          showToast(title ? `Added to ${title}` : "Added to playlist");
        } finally {
          pendingRef.current.delete(playlistId);
          setPendingIds([...pendingRef.current]);
        }
      })();
    },
    [videoIds, addToPlaylist, markAdded, showToast, titleOf],
  );

  const toggle = useCallback(
    (playlistId: string) => {
      if (videoIds.length === 0 || pendingRef.current.has(playlistId)) return;
      pendingRef.current.add(playlistId);
      setPendingIds([...pendingRef.current]);
      const wasAdded = addedRef.current.has(playlistId);
      const title = titleOf(playlistId);
      void (async () => {
        try {
          if (wasAdded) {
            const ok = await removeFromPlaylistVideo(playlistId, videoIds, setVideoIdsRef.current.get(playlistId));
            if (!ok) return;
            addedRef.current.delete(playlistId);
            setVideoIdsRef.current.delete(playlistId);
            setAddedIds([...addedRef.current]);
            showToast(title ? `Removed from ${title}` : "Removed from playlist");
            return;
          }
          const result = await addToPlaylist(playlistId, videoIds);
          if (!result.ok) return;
          if (result.duplicate) {
            // Keep the row marked, and let the toast force the add on request.
            markAdded(playlistId);
            showToast(title ? `Already in ${title}` : "Already in that playlist", "success", {
              label: "Add anyway",
              onClick: () => forceAdd(playlistId),
            });
            return;
          }
          markAdded(playlistId, result.setVideoIds);
          showToast(title ? `Added to ${title}` : "Added to playlist");
        } finally {
          pendingRef.current.delete(playlistId);
          setPendingIds([...pendingRef.current]);
        }
      })();
    },
    [videoIds, addToPlaylist, removeFromPlaylistVideo, titleOf, markAdded, showToast, forceAdd],
  );

  return { addedIds: new Set(addedIds), pendingIds: new Set(pendingIds), toggle };
};
