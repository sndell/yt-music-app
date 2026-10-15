import { useCallback, useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

/** The fields the album heart needs to match a library row and rate the album. */
export type RateableAlbum = {
  browseId: string;
  audioPlaylistId: string | null;
};

/**
 * Tracks which albums are in the account library and saves or removes one.
 *
 * YouTube Music rates an album through the same `rate_playlist` call as a
 * playlist, keyed by the album's `audioPlaylistId`; the library album list is
 * what tells the heart which state it starts in.
 */
export const useAlbumLibrary = () => {
  const { showToast } = useToast();
  const [savedIds, setSavedIds] = useState<Set<string> | null>(null);

  useEffect(() => {
    let active = true;
    void PyBridge.getLibraryAlbums().then((result) => {
      if (!active || !result.success) return;
      const ids = new Set<string>();
      for (const album of result.data) {
        if (album.browseId) ids.add(album.browseId);
        if (album.playlistId) ids.add(album.playlistId);
      }
      setSavedIds(ids);
    });
    return () => {
      active = false;
    };
  }, []);

  const isSaved = useCallback(
    (album: RateableAlbum) =>
      Boolean(
        savedIds?.has(album.browseId) ||
          (album.audioPlaylistId ? savedIds?.has(album.audioPlaylistId) : false),
      ),
    [savedIds],
  );

  const rateAlbum = useCallback(
    async (album: RateableAlbum, liked: boolean): Promise<boolean> => {
      if (!album.audioPlaylistId) return false;
      const result = await PyBridge.ratePlaylist(album.audioPlaylistId, liked ? "LIKE" : "INDIFFERENT");
      if (!result.success) {
        showToast(result.error.message || "Could not update your library", "error");
        return false;
      }
      const playlistId = album.audioPlaylistId;
      setSavedIds((current) => {
        const next = new Set(current ?? []);
        if (liked) {
          if (album.browseId) next.add(album.browseId);
          next.add(playlistId);
        } else {
          next.delete(album.browseId);
          next.delete(playlistId);
        }
        return next;
      });
      showToast(liked ? "Added album to your library" : "Removed album from your library");
      return true;
    },
    [showToast],
  );

  return { isSaved, rateAlbum };
};
