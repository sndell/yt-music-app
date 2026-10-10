import { PyBridge, type LikeStatus, type Track, type WatchTrack } from "@/lib/api";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

type PlayerContextType = {
  currentSong: Track | null;
  setCurrentSong: (song: Track) => void;
  queue: WatchTrack[];
  queueOpen: boolean;
  queueLoading: boolean;
  videoVisible: boolean;
  toggleQueue: () => void;
  toggleVideo: () => void;
  showBlockedEmbed: (videoId: string) => void;
  shuffle: boolean;
  toggleShuffle: () => void;
  ratingPending: boolean;
  trackRatings: Record<string, LikeStatus>;
  rateSong: (rating: LikeStatus) => Promise<void>;
  rateTrack: (videoId: string, displayed: LikeStatus, rating: LikeStatus) => Promise<void>;
  getWatchPlaylist: (videoId: string, playlistId?: string, radio?: boolean, shuffle?: boolean) => Promise<void>;
  playFromQueue: (track: WatchTrack, index?: number) => void;
  playFromPlaylist: (track: Track, playlistId?: string) => void;
  playTrackNext: (track: Track | WatchTrack) => void;
  addTrackToQueue: (track: Track | WatchTrack) => void;
  startMix: (track: Track | WatchTrack) => void;
  playPlaylist: (playlistId: string, mode: "play" | "shuffle" | "mix") => Promise<void>;
  queuePlaylist: (playlistId: string, position: "next" | "end") => Promise<void>;
  playTracks: (tracks: Track[]) => void;
  playNext: () => Promise<boolean>;
  playPrevious: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  currentQueueIndex: number;
};

const PlayerContext = createContext<PlayerContextType | null>(null);

const parseDuration = (length: string | null | undefined): number => {
  if (!length) return 0;
  const parts = length.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
};

const shuffleCopy = <T,>(items: readonly T[]): T[] => {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const splitAtIndex = (tracks: WatchTrack[], index: number) => {
  const splitAt = index < 0 ? 0 : index + 1;
  return {
    played: tracks.slice(0, splitAt),
    upcoming: tracks.slice(splitAt),
  };
};

const restoreUpcoming = (played: WatchTrack[], upcoming: WatchTrack[], snapshot: WatchTrack[]) => {
  const stillUpcoming = new Set(upcoming);
  const restored = snapshot.filter((track) => stillUpcoming.has(track));
  const saved = new Set(snapshot);
  const appended = upcoming.filter((track) => !saved.has(track));
  return [...played, ...restored, ...appended];
};

type LoadResult = "added" | "empty" | "stale";

const rememberVideoIds = (known: Set<string>, tracks: readonly WatchTrack[]) => {
  for (const track of tracks) {
    if (track.videoId) known.add(track.videoId);
  }
};

const libraryPlaylistId = (playlistId?: string | null): string | null => {
  if (!playlistId) return null;
  const id = playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
  if (!id || id.startsWith("RD")) return null;
  return id;
};

const isPlaylistTrack = (track: Track | WatchTrack): track is Track => "thumbnails" in track;

const trackToWatchTrack = (track: Track): WatchTrack => ({
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

const watchTrackToTrack = (track: WatchTrack): Track => ({
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

export const PlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const [currentSong, setCurrentSong] = useState<Track | null>(null);
  const [queue, setQueue] = useState<WatchTrack[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [videoVisible, setVideoVisible] = useState(false);
  const playingVideoId = currentSong?.videoId ?? null;
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueRevision, setQueueRevision] = useState(0);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [ratingPending, setRatingPending] = useState(false);
  const [trackRatings, setTrackRatings] = useState<Record<string, LikeStatus>>({});
  const requestIdRef = useRef(0);
  const queueRef = useRef<WatchTrack[]>([]);
  const queueOpenRef = useRef(false);
  const currentQueueIndexRef = useRef(-1);
  const shuffleRef = useRef(false);
  const currentSongRef = useRef<Track | null>(null);
  const ratingRequestRef = useRef(0);
  const ratingPendingRef = useRef(false);
  const knownRatingsRef = useRef<Record<string, LikeStatus>>({});
  const trackRatingRequestRef = useRef<Record<string, number>>({});
  // Upcoming tracks in pre-shuffle order. Identity is the track object, not videoId.
  const normalUpcomingRef = useRef<WatchTrack[] | null>(null);
  const watchPlaylistIdRef = useRef<string | null>(null);
  const sourcePlaylistIdRef = useRef<string | null>(null);
  const playlistExhaustedRef = useRef(false);
  const radioStartedRef = useRef(false);
  const playGenerationRef = useRef(0);
  const fillPromiseRef = useRef<Promise<boolean> | null>(null);
  const freshLoadRef = useRef<Promise<unknown> | null>(null);
  // Video ids already returned for this session. Extend uses this so those
  // tracks are not appended again.
  const knownVideoIdsRef = useRef<Set<string>>(new Set());

  const currentQueueIndex =
    currentSong && queue[queueIndex]?.videoId === currentSong.videoId
      ? queueIndex
      : currentSong
        ? queue.findIndex((track) => track.videoId === currentSong.videoId)
        : -1;
  const hasNext = currentQueueIndex >= 0 && currentQueueIndex < queue.length - 1;
  const hasPrevious = currentQueueIndex > 0;

  queueRef.current = queue;
  queueOpenRef.current = queueOpen;
  currentQueueIndexRef.current = currentQueueIndex;
  shuffleRef.current = shuffleOn;
  currentSongRef.current = currentSong;

  const toggleQueue = useCallback(() => {
    setQueueOpen((open) => !open);
  }, []);

  const toggleVideo = useCallback(() => {
    setVideoVisible((visible) => !visible);
  }, []);

  const showBlockedEmbed = useCallback((videoId: string) => {
    if (!videoId || currentSongRef.current?.videoId !== videoId) return;
    setQueueOpen(true);
    setVideoVisible(true);
  }, []);

  useLayoutEffect(() => {
    setVideoVisible(false);
  }, [playingVideoId]);

  const loadWatchPlaylist = useCallback(
    async (
      videoId: string,
      playlistId: string | undefined,
      radio: boolean,
      apiShuffle: boolean,
      extend: boolean,
      openQueue: boolean,
      generation: number
    ): Promise<LoadResult> => {
      if (playGenerationRef.current !== generation) return "stale";
      const requestId = ++requestIdRef.current;
      setQueueLoading(true);

      try {
        const result = await PyBridge.getWatchPlaylist(videoId, playlistId, radio, apiShuffle);
        if (requestId !== requestIdRef.current || playGenerationRef.current !== generation) return "stale";

        if (!result.success || !result.data || !Array.isArray(result.data.tracks)) return "empty";

        const tracks = result.data.tracks.filter((track) => track.videoId);
        let added = false;
        if (extend) {
          const current = queueRef.current;
          const seen = new Set(current.map((track) => track.videoId));
          const known = knownVideoIdsRef.current;
          const extra = tracks.filter(
            (track) => track.videoId && !seen.has(track.videoId) && !known.has(track.videoId)
          );
          rememberVideoIds(known, extra);
          if (extra.length > 0) {
            if (shuffleRef.current && normalUpcomingRef.current) {
              normalUpcomingRef.current = [...normalUpcomingRef.current, ...extra];
            }
            const next = [...current, ...extra];
            queueRef.current = next;
            setQueue(next);
            added = true;
          }
        } else {
          rememberVideoIds(knownVideoIdsRef.current, tracks);
          let nextIndex = tracks.findIndex((track) => track.videoId === videoId);
          let nextQueue = tracks;
          if (nextIndex < 0) {
            const seeded = queueRef.current.find((track) => track.videoId === videoId);
            if (seeded) {
              nextQueue = [seeded, ...tracks.filter((track) => track.videoId !== videoId)];
              nextIndex = 0;
            }
          }
          if (shuffleRef.current) {
            const { played, upcoming } = splitAtIndex(nextQueue, nextIndex);
            normalUpcomingRef.current = upcoming.slice();
            nextQueue = [...played, ...shuffleCopy(upcoming)];
          } else {
            normalUpcomingRef.current = null;
          }
          queueRef.current = nextQueue;
          currentQueueIndexRef.current = nextIndex;
          setQueue(nextQueue);
          setQueueIndex(nextIndex);
          const playing = nextIndex >= 0 ? nextQueue[nextIndex] : undefined;
          const song = currentSongRef.current;
          const playingArtists = playing?.artists ?? [];
          if (playing && song?.videoId === playing.videoId && !song.artists?.length && playingArtists.length > 0) {
            const nextSong = {
              ...song,
              artists: playingArtists.map((artist) => ({ name: artist.name, id: artist.id ?? "" })),
              album: song.album ?? playing.album ?? null,
            };
            currentSongRef.current = nextSong;
            setCurrentSong(nextSong);
          }
          setQueueRevision((revision) => revision + 1);
          if (openQueue && nextQueue.length > 0) setQueueOpen(true);
          added = nextQueue.length > 0;
        }
        if (result.data.playlistId) {
          watchPlaylistIdRef.current = result.data.playlistId;
        } else if (!extend) {
          watchPlaylistIdRef.current = null;
        }
        return added ? "added" : "empty";
      } finally {
        if (requestId === requestIdRef.current) setQueueLoading(false);
      }
    },
    []
  );

  const getWatchPlaylist = useCallback(
    async (videoId: string, playlistId?: string, radio = false, apiShuffle = false, seed?: Track | WatchTrack) => {
      playGenerationRef.current += 1;
      playlistExhaustedRef.current = false;
      radioStartedRef.current = false;
      sourcePlaylistIdRef.current = libraryPlaylistId(playlistId);
      fillPromiseRef.current = null;
      normalUpcomingRef.current = null;
      watchPlaylistIdRef.current = null;
      knownVideoIdsRef.current = new Set();
      const seeded = seed?.videoId ? (isPlaylistTrack(seed) ? trackToWatchTrack(seed) : { ...seed }) : null;
      if (seeded) {
        knownVideoIdsRef.current.add(seeded.videoId);
        queueRef.current = [seeded];
        currentQueueIndexRef.current = 0;
        setQueue([seeded]);
        setQueueIndex(0);
        setQueueOpen(true);
      } else {
        queueRef.current = [];
        currentQueueIndexRef.current = -1;
        setQueue([]);
        setQueueIndex(-1);
        if (!queueOpenRef.current) setQueueOpen(false);
      }
      const generation = playGenerationRef.current;
      const load = loadWatchPlaylist(videoId, playlistId, radio, apiShuffle, false, true, generation);
      freshLoadRef.current = load;
      try {
        await load;
      } finally {
        if (freshLoadRef.current === load) freshLoadRef.current = null;
      }
    },
    [loadWatchPlaylist]
  );

  const hasUpcoming = () => {
    const index = currentQueueIndexRef.current;
    return index >= 0 && index < queueRef.current.length - 1;
  };

  const startFill = useCallback((): Promise<boolean> => {
    if (hasUpcoming()) return Promise.resolve(true);
    const pending = fillPromiseRef.current;
    if (pending) return pending;

    const generation = playGenerationRef.current;
    const videoId = currentSongRef.current?.videoId;
    if (!videoId) return Promise.resolve(false);

    const run = async (): Promise<boolean> => {
      if (playGenerationRef.current !== generation) return false;
      if (hasUpcoming()) return true;

      if (!playlistExhaustedRef.current && watchPlaylistIdRef.current) {
        const outcome = await loadWatchPlaylist(
          videoId,
          watchPlaylistIdRef.current,
          false,
          false,
          true,
          false,
          generation
        );
        if (outcome === "stale" || playGenerationRef.current !== generation) return false;
        if (outcome === "added" || hasUpcoming()) return true;
        playlistExhaustedRef.current = true;
      } else if (!playlistExhaustedRef.current) {
        playlistExhaustedRef.current = true;
      }

      if (!radioStartedRef.current) {
        const source = sourcePlaylistIdRef.current;
        const outcome = await loadWatchPlaylist(
          videoId,
          source ? `RDAMPL${source}` : undefined,
          true,
          false,
          true,
          false,
          generation
        );
        if (outcome === "stale" || playGenerationRef.current !== generation) return false;
        radioStartedRef.current = true;
        if (outcome === "added" || hasUpcoming()) return true;
      }

      if (!watchPlaylistIdRef.current) return false;
      const outcome = await loadWatchPlaylist(
        videoId,
        watchPlaylistIdRef.current,
        false,
        false,
        true,
        false,
        generation
      );
      if (outcome === "stale" || playGenerationRef.current !== generation) return false;
      return outcome === "added" || hasUpcoming();
    };

    const promise = run().finally(() => {
      if (fillPromiseRef.current === promise) fillPromiseRef.current = null;
    });
    fillPromiseRef.current = promise;
    return promise;
  }, [loadWatchPlaylist]);

  const fillQueue = useCallback((): Promise<boolean> => {
    const fresh = freshLoadRef.current;
    if (!fresh) return startFill();
    return fresh.then(() => startFill());
  }, [startFill]);

  useEffect(() => {
    if (freshLoadRef.current) return;
    if (!currentSong?.videoId) return;
    if (currentQueueIndex < 0 || currentQueueIndex < queue.length - 1) return;
    void fillQueue();
  }, [currentQueueIndex, currentSong?.videoId, fillQueue, queue.length, queueRevision]);

  const toggleShuffle = useCallback(() => {
    const tracks = queueRef.current;
    const { played, upcoming } = splitAtIndex(tracks, currentQueueIndexRef.current);

    if (shuffleRef.current) {
      const snapshot = normalUpcomingRef.current;
      shuffleRef.current = false;
      setShuffleOn(false);
      normalUpcomingRef.current = null;
      if (!snapshot) return;
      const next = restoreUpcoming(played, upcoming, snapshot);
      queueRef.current = next;
      setQueue(next);
      return;
    }

    normalUpcomingRef.current = upcoming.slice();
    const next = [...played, ...shuffleCopy(upcoming)];
    shuffleRef.current = true;
    setShuffleOn(true);
    queueRef.current = next;
    setQueue(next);
  }, []);

  const applyLikeStatus = useCallback((videoId: string, status: LikeStatus) => {
    knownRatingsRef.current[videoId] = status;
    setTrackRatings((current) => (current[videoId] === status ? current : { ...current, [videoId]: status }));
    setCurrentSong((song) => {
      if (!song || song.videoId !== videoId || song.likeStatus === status) return song;
      return { ...song, likeStatus: status };
    });
    const tracks = queueRef.current;
    let changed = false;
    for (const track of tracks) {
      if (track.videoId === videoId && track.likeStatus !== status) {
        track.likeStatus = status;
        changed = true;
      }
      const counterpart = track.counterpart;
      if (counterpart?.videoId === videoId && counterpart.likeStatus !== status) {
        counterpart.likeStatus = status;
        changed = true;
      }
    }
    if (changed) {
      const next = tracks.slice();
      queueRef.current = next;
      setQueue(next);
    }
  }, []);

  const rateSong = useCallback(
    async (rating: LikeStatus) => {
      const song = currentSongRef.current;
      if (!song?.videoId || ratingPendingRef.current) return;
      const videoId = song.videoId;
      const previous = song.likeStatus ?? "INDIFFERENT";
      const next = previous === rating ? "INDIFFERENT" : rating;
      ratingRequestRef.current += 1;
      ratingPendingRef.current = true;
      setRatingPending(true);
      applyLikeStatus(videoId, next);
      const result = await PyBridge.rateSong(videoId, next);
      ratingPendingRef.current = false;
      setRatingPending(false);
      if (!result.success) applyLikeStatus(videoId, previous);
    },
    [applyLikeStatus]
  );

  const rateTrack = useCallback(
    async (videoId: string, displayed: LikeStatus, rating: LikeStatus) => {
      if (!videoId) return;
      const previous = knownRatingsRef.current[videoId] ?? displayed;
      const next = previous === rating ? "INDIFFERENT" : rating;
      const request = (trackRatingRequestRef.current[videoId] ?? 0) + 1;
      trackRatingRequestRef.current[videoId] = request;
      applyLikeStatus(videoId, next);
      const result = await PyBridge.rateSong(videoId, next);
      if (trackRatingRequestRef.current[videoId] !== request) return;
      if (!result.success) applyLikeStatus(videoId, previous);
    },
    [applyLikeStatus]
  );

  useEffect(() => {
    const videoId = currentSong?.videoId;
    if (!videoId) return;
    const request = ++ratingRequestRef.current;
    let cancelled = false;
    void (async () => {
      const result = await PyBridge.getSongRating(videoId);
      if (cancelled || request !== ratingRequestRef.current) return;
      if (result.success && result.data?.likeStatus) applyLikeStatus(videoId, result.data.likeStatus);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLikeStatus, currentSong?.videoId]);

  const enqueueTrack = useCallback((source: Track | WatchTrack, position: "next" | "end") => {
    if (isPlaylistTrack(source) && !source.isAvailable) return;
    const track = isPlaylistTrack(source) ? trackToWatchTrack(source) : { ...source };
    if (!track.videoId) return;
    knownVideoIdsRef.current.add(track.videoId);

    const current = queueRef.current;
    const index = currentQueueIndexRef.current;
    const insertAt = position === "end" ? current.length : index >= 0 ? index + 1 : 0;
    const next = current.slice();
    next.splice(insertAt, 0, track);
    queueRef.current = next;
    setQueue(next);

    if (shuffleRef.current && normalUpcomingRef.current) {
      normalUpcomingRef.current =
        position === "next" ? [track, ...normalUpcomingRef.current] : [...normalUpcomingRef.current, track];
    }
  }, []);

  const playTrackNext = useCallback((track: Track | WatchTrack) => enqueueTrack(track, "next"), [enqueueTrack]);

  const addTrackToQueue = useCallback((track: Track | WatchTrack) => enqueueTrack(track, "end"), [enqueueTrack]);

  const startMix = useCallback(
    (source: Track | WatchTrack) => {
      if (isPlaylistTrack(source) && !source.isAvailable) return;
      const song = isPlaylistTrack(source) ? source : watchTrackToTrack(source);
      if (!song.videoId) return;
      currentSongRef.current = song;
      setCurrentSong(song);
      void getWatchPlaylist(song.videoId, undefined, true, false, source);
    },
    [getWatchPlaylist]
  );

  const playPlaylist = useCallback(
    async (playlistId: string, mode: "play" | "shuffle" | "mix") => {
      if (!playlistId) return;
      if (mode === "play") {
        shuffleRef.current = false;
        setShuffleOn(false);
      } else if (mode === "shuffle") {
        shuffleRef.current = true;
        setShuffleOn(true);
      }

      playGenerationRef.current += 1;
      playlistExhaustedRef.current = false;
      radioStartedRef.current = false;
      sourcePlaylistIdRef.current = libraryPlaylistId(playlistId);
      fillPromiseRef.current = null;
      normalUpcomingRef.current = null;
      watchPlaylistIdRef.current = null;
      knownVideoIdsRef.current = new Set();
      queueRef.current = [];
      currentQueueIndexRef.current = -1;
      setQueue([]);
      setQueueIndex(-1);

      const generation = playGenerationRef.current;
      const load = loadWatchPlaylist("", playlistId, mode === "mix", mode === "shuffle", false, true, generation);
      freshLoadRef.current = load;
      try {
        await load;
      } finally {
        if (freshLoadRef.current === load) freshLoadRef.current = null;
      }
      if (playGenerationRef.current !== generation) return;

      const first = queueRef.current[0];
      if (!first?.videoId) return;
      currentQueueIndexRef.current = 0;
      setQueueIndex(0);
      const song = watchTrackToTrack(first);
      currentSongRef.current = song;
      setCurrentSong(song);
    },
    [loadWatchPlaylist]
  );

  const queuePlaylist = useCallback(async (playlistId: string, position: "next" | "end") => {
    if (!playlistId) return;
    const result = await PyBridge.getPlaylistItems(playlistId);
    if (!result.success || !Array.isArray(result.data?.tracks)) return;
    const tracks = result.data.tracks.filter((track) => track.videoId && track.isAvailable).map(trackToWatchTrack);
    if (tracks.length === 0) return;

    rememberVideoIds(knownVideoIdsRef.current, tracks);
    const current = queueRef.current;
    const index = currentQueueIndexRef.current;
    const insertAt = position === "end" ? current.length : index >= 0 ? index + 1 : 0;
    const next = current.slice();
    next.splice(insertAt, 0, ...tracks);
    queueRef.current = next;
    setQueue(next);

    if (shuffleRef.current && normalUpcomingRef.current) {
      normalUpcomingRef.current =
        position === "next" ? [...tracks, ...normalUpcomingRef.current] : [...normalUpcomingRef.current, ...tracks];
    }
  }, []);

  const playTracks = useCallback((tracks: Track[]) => {
    const playable = tracks.filter((track) => track.videoId && track.isAvailable);
    if (playable.length === 0) return;
    const song = playable[0];
    const next = playable.map(trackToWatchTrack);
    playGenerationRef.current += 1;
    requestIdRef.current += 1;
    setQueueLoading(false);
    playlistExhaustedRef.current = false;
    radioStartedRef.current = false;
    sourcePlaylistIdRef.current = null;
    fillPromiseRef.current = null;
    freshLoadRef.current = null;
    watchPlaylistIdRef.current = null;
    knownVideoIdsRef.current = new Set(next.map((track) => track.videoId));

    let queued = next;
    if (shuffleRef.current) {
      const upcoming = next.slice(1);
      normalUpcomingRef.current = upcoming.slice();
      queued = [next[0], ...shuffleCopy(upcoming)];
    } else {
      normalUpcomingRef.current = null;
    }

    currentSongRef.current = song;
    setCurrentSong(song);
    queueRef.current = queued;
    currentQueueIndexRef.current = 0;
    setQueue(queued);
    setQueueIndex(0);
    setQueueRevision((revision) => revision + 1);
  }, []);

  const playFromQueue = useCallback(
    (track: WatchTrack, index?: number) => {
      if (!track.videoId) return;
      const resolvedIndex =
        index != null && queue[index]?.videoId === track.videoId
          ? index
          : queue.findIndex((item) => item.videoId === track.videoId);
      if (resolvedIndex >= 0) {
        currentQueueIndexRef.current = resolvedIndex;
        setQueueIndex(resolvedIndex);
      }
      currentSongRef.current = watchTrackToTrack(track);
      setCurrentSong(currentSongRef.current);
      if (resolvedIndex >= 0 && resolvedIndex === queue.length - 1) void fillQueue();
    },
    [fillQueue, queue]
  );

  const playFromPlaylist = useCallback(
    (track: Track, playlistId?: string) => {
      if (!track.videoId) return;
      const source = libraryPlaylistId(playlistId);
      const samePlaylist = source !== null && source === sourcePlaylistIdRef.current;
      if (samePlaylist) {
        const existingIndex = queueRef.current.findIndex((item) => item.videoId === track.videoId);
        if (existingIndex >= 0) {
          if (existingIndex !== currentQueueIndexRef.current) {
            const queue = queueRef.current;
            const oldIndex = currentQueueIndexRef.current;
            if (shuffleRef.current && normalUpcomingRef.current) {
              const stillUpcoming = new Set(queue.slice(existingIndex + 1));
              const kept = normalUpcomingRef.current.filter((item) => stillUpcoming.has(item));
              const keptIds = new Set(kept);
              const reentered =
                existingIndex < oldIndex
                  ? queue.slice(existingIndex + 1, oldIndex + 1).filter((item) => !keptIds.has(item))
                  : [];
              normalUpcomingRef.current = [...reentered, ...kept];
            }
            currentQueueIndexRef.current = existingIndex;
            setQueueIndex(existingIndex);
            if (existingIndex === queue.length - 1) void fillQueue();
          }
          currentSongRef.current = track;
          setCurrentSong(track);
          return;
        }
      }
      currentSongRef.current = track;
      setCurrentSong(track);
      void getWatchPlaylist(track.videoId, playlistId, false, false, track);
    },
    [fillQueue, getWatchPlaylist]
  );

  const playNext = useCallback(async (): Promise<boolean> => {
    const generation = playGenerationRef.current;
    if (!hasUpcoming()) {
      const filled = await fillQueue();
      if (playGenerationRef.current !== generation) return true;
      if (!filled || !hasUpcoming()) return false;
    }
    if (playGenerationRef.current !== generation) return true;
    const index = currentQueueIndexRef.current + 1;
    const track = queueRef.current[index];
    if (!track?.videoId) return false;
    currentQueueIndexRef.current = index;
    setQueueIndex(index);
    currentSongRef.current = watchTrackToTrack(track);
    setCurrentSong(currentSongRef.current);
    return true;
  }, [fillQueue]);

  const playPrevious = useCallback(() => {
    if (!hasPrevious) return;
    const track = queue[currentQueueIndex - 1];
    if (!track?.videoId) return;
    setQueueIndex(currentQueueIndex - 1);
    setCurrentSong(watchTrackToTrack(track));
  }, [currentQueueIndex, hasPrevious, queue]);

  return (
    <PlayerContext.Provider
      value={{
        currentSong,
        setCurrentSong,
        queue,
        queueOpen,
        queueLoading,
        videoVisible,
        toggleQueue,
        toggleVideo,
        showBlockedEmbed,
        shuffle: shuffleOn,
        toggleShuffle,
        ratingPending,
        trackRatings,
        rateSong,
        rateTrack,
        getWatchPlaylist,
        playFromQueue,
        playFromPlaylist,
        playTrackNext,
        addTrackToQueue,
        startMix,
        playPlaylist,
        queuePlaylist,
        playTracks,
        playNext,
        playPrevious,
        hasNext,
        hasPrevious,
        currentQueueIndex,
      }}
    >
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
};
