import { useCallback, useRef, useState } from "react";
import { PyBridge, showCachedThenRefresh } from "@/lib/api";
import type { LibraryAlbum, LibraryArtist, Result, Track } from "@/lib/api/types";

// One large page per category. YouTube Music has no offset, only a limit, so a
// second page would re-fetch from the top; the list is cached whole instead.
const SONGS_LIMIT = 5000;
const ALBUMS_LIMIT = 1000;
const ARTISTS_LIMIT = 2000;

/** Cache-first load for one category, run at most once per key. */
const loadOnce = <T extends { fromCache?: boolean; stale?: boolean }>(
  started: Set<string>,
  key: string,
  request: (forceRefresh: boolean) => Promise<Result<T>>,
  apply: (data: T) => void,
  fail: (message: string) => void,
  force = false,
) => {
  if (started.has(key)) return;
  started.add(key);
  void showCachedThenRefresh(request, apply, () => true, { force }).then((result) => {
    if (result && !result.success) fail(result.error.message);
  });
};

export type LibraryData = {
  /** Null until the category has been asked for; empty when the library is. */
  songs: Track[] | null;
  songsError: string | null;
  albums: LibraryAlbum[] | null;
  albumsError: string | null;
  artists: LibraryArtist[] | null;
  artistsError: string | null;
  loadSongs: () => void;
  loadAlbums: () => void;
  loadArtists: () => void;
  /** Drop everything and load again, e.g. after the account changes. */
  reload: () => void;
  /** Bumps so the page's view effect runs the loads again after a reload. */
  revision: number;
};

/**
 * Per-category library data, fetched only when a view asks for it and kept for
 * the life of the page. Python's disk cache paints first and refreshes in the
 * background, so switching chips back and forth costs nothing.
 */
export const useLibraryData = (): LibraryData => {
  const [songs, setSongs] = useState<Track[] | null>(null);
  const [songsError, setSongsError] = useState<string | null>(null);
  const [albums, setAlbums] = useState<LibraryAlbum[] | null>(null);
  const [albumsError, setAlbumsError] = useState<string | null>(null);
  const [artists, setArtists] = useState<LibraryArtist[] | null>(null);
  const [artistsError, setArtistsError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const startedRef = useRef(new Set<string>());
  // A reload (the error state's button, or a sign-in change) must read the
  // account again even when the disk copy is younger than its refresh window.
  const forceRef = useRef(false);

  const loadSongs = useCallback(() => {
    loadOnce(
      startedRef.current,
      "songs",
      (forceRefresh) => PyBridge.getLibrarySongs(SONGS_LIMIT, forceRefresh),
      (data) => setSongs(data.songs),
      setSongsError,
      forceRef.current,
    );
  }, []);

  const loadAlbums = useCallback(() => {
    loadOnce(
      startedRef.current,
      "albums",
      (forceRefresh) => PyBridge.getLibraryAlbums(ALBUMS_LIMIT, forceRefresh),
      (data) => setAlbums(data.albums),
      setAlbumsError,
      forceRef.current,
    );
  }, []);

  const loadArtists = useCallback(() => {
    loadOnce(
      startedRef.current,
      "artists",
      (forceRefresh) => PyBridge.getLibraryArtists(ARTISTS_LIMIT, forceRefresh),
      (data) => setArtists(data.artists),
      setArtistsError,
      forceRef.current,
    );
  }, []);

  const reload = useCallback(() => {
    startedRef.current.clear();
    forceRef.current = true;
    setSongs(null);
    setSongsError(null);
    setAlbums(null);
    setAlbumsError(null);
    setArtists(null);
    setArtistsError(null);
    setRevision((value) => value + 1);
  }, []);

  return {
    songs,
    songsError,
    albums,
    albumsError,
    artists,
    artistsError,
    loadSongs,
    loadAlbums,
    loadArtists,
    reload,
    revision,
  };
};
