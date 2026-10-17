/** The player's queue model: types, randomness and track conversions.
 *  Kept out of PlayerContext.tsx so the state file reads as state. */

import type { LikeStatus, LyricLine, Track, WatchTrack, WatchTunerChip } from "@/lib/api";

export type SongLyrics = {
  videoId: string;
  text: string;
  source: string | null;
  lines: LyricLine[];
};

export type PlayerContextType = {
  currentSong: Track | null;
  setCurrentSong: (song: Track) => void;
  /** Lyrics for the playing song, or null while unknown or when it has none. */
  lyrics: SongLyrics | null;
  queue: WatchTrack[];
  queueOpen: boolean;
  queueLoading: boolean;
  /** Selected mix tuner chip id; "All" is the plain song mix. */
  queueTuner: string;
  /** Genre chips for the playing song's mix. Empty when the queue has none. */
  queueChips: WatchTunerChip[];
  selectQueueTuner: (chip: WatchTunerChip) => void;
  toggleQueue: () => void;
  shuffle: boolean;
  toggleShuffle: () => void;
  ratingPending: boolean;
  trackRatings: Record<string, LikeStatus>;
  rateSong: (rating: LikeStatus) => Promise<void>;
  rateTrack: (videoId: string, displayed: LikeStatus, rating: LikeStatus) => Promise<void>;
  getWatchPlaylist: (videoId: string, playlistId?: string, radio?: boolean, shuffle?: boolean) => Promise<void>;
  playFromQueue: (track: WatchTrack, index?: number) => void;
  reorderQueue: (from: number, to: number) => void;
  playFromPlaylist: (track: Track, playlistId?: string, tunable?: boolean) => void;
  playTrackNext: (track: Track | WatchTrack) => void;
  addTrackToQueue: (track: Track | WatchTrack) => void;
  startMix: (track: Track | WatchTrack) => void;
  playPlaylist: (playlistId: string, mode: "play" | "shuffle" | "mix", tunable?: boolean) => Promise<void>;
  queuePlaylist: (playlistId: string, position: "next" | "end") => Promise<void>;
  playTracks: (tracks: Track[], preserveOrder?: boolean) => void;
  /** Start a list in a true-random order (OS CSPRNG). Album/playlist only. */
  trueShuffle: (tracks: Track[]) => Promise<void>;
  /** Fetch every song in a playlist, then start it true-randomly shuffled. */
  trueShufflePlaylist: (playlistId: string) => Promise<void>;
  /**
   * True while a true shuffle is still reading the rest of the list behind the
   * queue. The opening song is already playing; the shuffled order lands later.
   */
  shufflePending: boolean;
  playNext: () => Promise<boolean>;
  playPrevious: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  currentQueueIndex: number;
  /** Bumps when a fresh queue replaces the list, not when it is reordered or extended. */
  queueRevision: number;
  /** Bumps only when reaching the end appends more tracks. */
  queueFill: number;
  /** Music video id for the current song, or null when it has none. */
  currentVideoId: string | null;
  /** Video overlay drawn over the routed content. */
  videoOpen: boolean;
  toggleVideo: () => void;
};


export const parseDuration = (length: string | null | undefined): number => {
  if (!length) return 0;
  const parts = length.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
};

export const shuffleCopy = <T,>(items: readonly T[]): T[] => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

/**
 * Unbiased index in [0, max) drawn from the browser CSPRNG. Rejection sampling
 * avoids the modulo bias a plain `%` would introduce.
 */
export const secureRandomIndex = (max: number): number => {
  if (max <= 1) return 0;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % max;
};

export const splitAtIndex = (tracks: WatchTrack[], index: number) => {
  const splitAt = index < 0 ? 0 : index + 1;
  return {
    played: tracks.slice(0, splitAt),
    upcoming: tracks.slice(splitAt),
  };
};

export const restoreUpcoming = (played: WatchTrack[], upcoming: WatchTrack[], snapshot: WatchTrack[]) => {
  const stillUpcoming = new Set(upcoming);
  const restored = snapshot.filter((track) => stillUpcoming.has(track));
  const saved = new Set(snapshot);
  const appended = upcoming.filter((track) => !saved.has(track));
  return [...played, ...restored, ...appended];
};

export type LoadResult = "added" | "empty" | "stale";

export const rememberVideoIds = (known: Set<string>, tracks: readonly WatchTrack[]) => {
  for (const track of tracks) {
    if (track.videoId) known.add(track.videoId);
  }
};

export const libraryPlaylistId = (playlistId?: string | null): string | null => {
  if (!playlistId) return null;
  const id = playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
  if (!id || id.startsWith("RD")) return null;
  return id;
};

export const isPlaylistTrack = (track: Track | WatchTrack): track is Track => "thumbnails" in track;

export const trackToWatchTrack = (track: Track): WatchTrack => ({
  videoId: track.videoId,
  title: track.title,
  length: track.duration,
  thumbnail: track.thumbnails,
  likeStatus: track.likeStatus,
  videoType: track.videoType,
  inLibrary: track.inLibrary,
  feedbackTokens: null,
  pinnedToListenAgain: null,
  listenAgainFeedbackTokens: null,
  artists: track.artists,
  album: track.album,
});

export const watchTrackToTrack = (track: WatchTrack): Track => ({
  videoId: track.videoId,
  title: track.title,
  artists: (track.artists ?? []).map((artist) => ({ name: artist.name, id: artist.id ?? "" })),
  album: track.album ?? null,
  likeStatus: track.likeStatus ?? "INDIFFERENT",
  inLibrary: track.inLibrary ?? false,
  thumbnails: track.thumbnail ?? [],
  isAvailable: true,
  isExplicit: false,
  videoType: track.videoType ?? "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: track.length ?? "",
  durationSeconds: parseDuration(track.length),
  setVideoId: "",
});
