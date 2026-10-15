/**
 * PyWebView Bridge - Type-safe communication with Python backend
 */

import type {
  ApiMethodName,
  ApiParams,
  ApiResponse,
  PlaylistItemRef,
  PlaylistPatch,
  PlaylistPrivacy,
  Result,
  SearchFilter,
  SearchScope,
} from "./types";

const BRIDGE_TIMEOUT_MS = 30_000;
const DEBUG = import.meta.env.DEV;

function log(level: "info" | "warn" | "error", message: string, ...args: unknown[]) {
  if (!DEBUG && level === "info") return;
  console[level](`[PyBridge] ${message}`, ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMethod(method: string, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (window.pywebview?.api && typeof window.pywebview.api[method as ApiMethodName] === "function") {
      return true;
    }
    await sleep(50);
  }

  return false;
}

async function callPython<M extends ApiMethodName>(
  method: M,
  ...args: ApiParams<M>
): Promise<Result<ApiResponse<M>>> {
  try {
    const ready = await waitForMethod(method);

    if (!ready) {
      log("error", `Method "${method}" not found on Python API (timeout)`);
      return { success: false, error: { code: "METHOD_NOT_FOUND", message: `Method "${method}" not found` } };
    }

    const fn = window.pywebview!.api[method];
    log("info", `Calling ${method}`, args);
    const result = await fn(...args);
    log("info", `${method} returned`, result);

    return { success: true, data: result as ApiResponse<M> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", `${method} failed:`, message);
    return { success: false, error: { code: "CALL_FAILED", message } };
  }
}

/** Paint a cached payload, then replace it when the background fetch finishes. */
export async function showCachedThenRefresh<T extends { fromCache?: boolean }>(
  load: (forceRefresh: boolean) => Promise<Result<T>>,
  apply: (data: T) => void,
  isCurrent: () => boolean,
): Promise<Result<T> | null> {
  const first = await load(false);
  if (!isCurrent()) return null;
  if (!first.success) return first;
  apply(first.data);
  if (!first.data.fromCache) return first;

  const fresh = await load(true);
  if (!isCurrent() || !fresh.success) return first;
  apply(fresh.data);
  return fresh;
}

/** Type-safe access to all Python API methods */
export const PyBridge = {
  getCoverColor: (imageUrl: string) => callPython("get_cover_color", imageUrl),
  inlineThumbnail: (imageUrl: string) => callPython("inline_thumbnail", imageUrl),
  getPlaylists: () => callPython("get_playlists"),
  getLibraryAlbums: (limit = 500) => callPython("get_library_albums", limit),
  getLibrarySongs: (limit = 5000) => callPython("get_library_songs", limit),
  getLibraryArtists: (limit = 5000) => callPython("get_library_artists", limit),
  getQuickPicks: () => callPython("get_quick_picks"),
  getHome: (forceRefresh = false) => callPython("get_home", forceRefresh),
  search: (query: string, filter: SearchFilter | "" = "", scope: SearchScope | "" = "", limit = 30) =>
    callPython("search", query, filter, scope, limit),
  shuffleTracks: (videoIds: string[]) => callPython("shuffle_tracks", videoIds),
  getPlaylistItems: (playlistId: string, forceRefresh = false) =>
    callPython("get_playlist_items", playlistId, forceRefresh),
  movePlaylistItem: (playlistId: string, setVideoId: string, beforeSetVideoId = "") =>
    callPython("move_playlist_item", playlistId, setVideoId, beforeSetVideoId),
  addPlaylistItems: (playlistId: string, videoIds: string[]) =>
    callPython("add_playlist_items", playlistId, videoIds),
  removePlaylistItems: (playlistId: string, items: PlaylistItemRef[]) =>
    callPython("remove_playlist_items", playlistId, items),
  editPlaylist: (playlistId: string, patch: PlaylistPatch) => callPython("edit_playlist", playlistId, patch),
  deletePlaylist: (playlistId: string) => callPython("delete_playlist", playlistId),
  createPlaylist: (title: string, description = "", privacy: PlaylistPrivacy = "PRIVATE", videoIds: string[] = []) =>
    callPython("create_playlist", title, description, privacy, videoIds),
  ratePlaylist: (playlistId: string, rating: "LIKE" | "INDIFFERENT" = "LIKE") =>
    callPython("rate_playlist", playlistId, rating),
  getRecommendedPlaylists: (limit = 4) => callPython("get_recommended_playlists", limit),
  getAlbum: (browseId: string, forceRefresh = false) => callPython("get_album", browseId, forceRefresh),
  getArtist: (channelId: string, forceRefresh = false) => callPython("get_artist", channelId, forceRefresh),
  getArtistAlbums: (channelId: string, params: string) => callPython("get_artist_albums", channelId, params),
  getWatchPlaylist: (videoId?: string, playlistId?: string, radio = false, shuffle = false) =>
    callPython("get_watch_playlist", videoId ?? "", playlistId ?? "", radio, shuffle),
  getQueueTuner: (videoId: string) => callPython("get_queue_tuner", videoId),
  signIn: () => callPython("sign_in"),
  isSignedIn: () => callPython("is_signed_in"),
  signOut: () => callPython("sign_out"),
  invalidatePlaylistCache: (playlistIds: string[]) => callPython("invalidate_playlist_cache", playlistIds),
  clearAllCache: () => callPython("clear_all_cache"),
  updateMediaControls: (title: string, artist: string, playing: boolean, hasNext: boolean, artwork: string) =>
    callPython("update_media_controls", title, artist, playing, hasNext, artwork),
  getVolume: () => callPython("get_volume"),
  setVolume: (volume: number) => callPython("set_volume", volume),
  getDiscordPresence: () => callPython("get_discord_presence"),
  setDiscordPresence: (enabled: boolean) => callPython("set_discord_presence", enabled),
  updateDiscordPresence: (
    title: string,
    artist: string,
    album: string,
    playing: boolean,
    elapsed: number,
    duration: number,
    artwork: string,
    videoId: string
  ) => callPython("update_discord_presence", title, artist, album, playing, elapsed, duration, artwork, videoId),
  getAudioStream: (videoId: string, refresh = false) => callPython("get_audio_stream", videoId, refresh),
  getSongRating: (videoId: string) => callPython("get_song_rating", videoId),
  rateSong: (videoId: string, rating: "LIKE" | "DISLIKE" | "INDIFFERENT") =>
    callPython("rate_song", videoId, rating),
  addSongToHistory: (videoId: string) => callPython("add_song_to_history", videoId),
} as const;
