import { PyBridge, type LikeStatus, type Track, type WatchTrack, type WatchTunerChip } from "@/lib/api";
import { moveItem } from "@/lib/orderMap";
import { musicVideoId } from "../lib/musicVideo";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  shuffleCopy,
  secureRandomIndex,
  splitAtIndex,
  restoreUpcoming,
  rememberVideoIds,
  libraryPlaylistId,
  isPlaylistTrack,
  trackToWatchTrack,
  watchTrackToTrack,
  type LoadResult,
  type PlayerContextType,
  type SongLyrics,
} from "../lib/queueModel";

export type { PlayerContextType, SongLyrics } from "../lib/queueModel";

const PlayerContext = createContext<PlayerContextType | null>(null);

/** Lyrics for one song, resolved by its video id. */

export const PlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const [currentSong, setCurrentSong] = useState<Track | null>(null);
  const [queue, setQueue] = useState<WatchTrack[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueTuner, setQueueTuner] = useState("All");
  const [queueChips, setQueueChips] = useState<WatchTunerChip[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [queueRevision, setQueueRevision] = useState(0);
  const [queueFill, setQueueFill] = useState(0);
  const [videoOpen, setVideoOpen] = useState(false);
  const [shufflePendingFor, setShufflePendingFor] = useState<string | null>(null);
  const [lyricsState, setLyricsState] = useState<SongLyrics | null>(null);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [ratingPending, setRatingPending] = useState(false);
  const [trackRatings, setTrackRatings] = useState<Record<string, LikeStatus>>({});
  const requestIdRef = useRef(0);
  const queueRef = useRef<WatchTrack[]>([]);
  const queueOpenRef = useRef(false);
  const queueTunerRef = useRef("All");
  const currentQueueIndexRef = useRef(-1);
  const shuffleRef = useRef(false);
  const currentSongRef = useRef<Track | null>(null);
  const ratingRequestRef = useRef(0);
  const ratingPendingRef = useRef(false);
  const knownRatingsRef = useRef<Record<string, LikeStatus>>({});
  const trackRatingRequestRef = useRef<Record<string, number>>({});
  // Upcoming tracks in pre-shuffle order. Identity is the track object, not videoId.
  const normalUpcomingRef = useRef<WatchTrack[] | null>(null);
  const shuffleRequestRef = useRef(0);
  const lyricsRequestRef = useRef(0);
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
  const currentVideoId = musicVideoId(currentQueueIndex >= 0 ? queue[currentQueueIndex] : null);
  // The spinner clears on its own if the song changes mid-read, so the pending
  // song is what marks it, not a bare flag.
  const shufflePending = shufflePendingFor !== null && shufflePendingFor === currentSong?.videoId;
  // Scoped to the playing song, so a payload read for the previous one is not
  // shown while the next is still being read.
  const lyrics = lyricsState && lyricsState.videoId === currentSong?.videoId ? lyricsState : null;

  queueRef.current = queue;
  queueOpenRef.current = queueOpen;
  currentQueueIndexRef.current = currentQueueIndex;
  shuffleRef.current = shuffleOn;
  currentSongRef.current = currentSong;

  const toggleQueue = useCallback(() => {
    setQueueOpen((open) => !open);
  }, []);

  const toggleVideo = useCallback(() => {
    setVideoOpen((open) => !open);
  }, []);

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
            setQueueFill((fill) => fill + 1);
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
    async (
      videoId: string,
      playlistId?: string,
      radio = false,
      apiShuffle = false,
      seed?: Track | WatchTrack,
      tunable?: boolean
    ) => {
      playGenerationRef.current += 1;
      playlistExhaustedRef.current = false;
      radioStartedRef.current = false;
      sourcePlaylistIdRef.current = libraryPlaylistId(playlistId);
      fillPromiseRef.current = null;
      normalUpcomingRef.current = null;
      watchPlaylistIdRef.current = null;
      knownVideoIdsRef.current = new Set();
      // A fresh queue starts untuned. Genre chips exist for song and mix plays,
      // not for a fixed album or library playlist.
      queueTunerRef.current = "All";
      setQueueTuner("All");
      setQueueChips([]);
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
      // Tuner chips track the playing song's automix. Default to song and mix
      // plays (a bare video or an RD radio); callers can opt a fixed collection
      // in or out explicitly.
      const tunerAllowed = tunable ?? libraryPlaylistId(playlistId) === null;
      if (videoId && tunerAllowed) {
        void PyBridge.getQueueTuner(videoId).then((result) => {
          if (playGenerationRef.current !== generation) return;
          if (result.success && Array.isArray(result.data)) setQueueChips(result.data);
        });
      }
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

  // A tuner change only swaps what is still ahead. Played tracks and the
  // current song stay where they are, like the real queue tuner.
  const refreshUpcoming = useCallback(async (videoId: string, playlistId: string, generation: number) => {
    const requestId = ++requestIdRef.current;
    setQueueLoading(true);
    try {
      const result = await PyBridge.getWatchPlaylist(videoId, playlistId, false, false);
      if (requestId !== requestIdRef.current || playGenerationRef.current !== generation) return;
      if (!result.success || !result.data || !Array.isArray(result.data.tracks)) return;

      const incoming = result.data.tracks.filter((track) => track.videoId);
      const current = queueRef.current;
      const index = currentQueueIndexRef.current;
      const played = index >= 0 ? current.slice(0, index + 1) : current.slice();
      const seen = new Set(played.map((track) => track.videoId));
      const upcoming = incoming.filter((track) => track.videoId && !seen.has(track.videoId));
      rememberVideoIds(knownVideoIdsRef.current, upcoming);

      const next = [...played, ...upcoming];
      queueRef.current = next;
      setQueue(next);
      normalUpcomingRef.current = shuffleRef.current ? upcoming.slice() : null;
      if (result.data.playlistId) watchPlaylistIdRef.current = result.data.playlistId;
      playlistExhaustedRef.current = false;
      radioStartedRef.current = false;
      setQueueRevision((revision) => revision + 1);
    } finally {
      if (requestId === requestIdRef.current) setQueueLoading(false);
    }
  }, []);

  const selectQueueTuner = useCallback(
    (chip: WatchTunerChip) => {
      const song = currentSongRef.current;
      if (!song?.videoId || !chip.playlistId) return;
      if (queueTunerRef.current === chip.id) return;
      queueTunerRef.current = chip.id;
      setQueueTuner(chip.id);
      playGenerationRef.current += 1;
      playlistExhaustedRef.current = false;
      radioStartedRef.current = false;
      sourcePlaylistIdRef.current = null;
      fillPromiseRef.current = null;
      normalUpcomingRef.current = null;
      watchPlaylistIdRef.current = null;
      knownVideoIdsRef.current = new Set([song.videoId]);
      const generation = playGenerationRef.current;
      void refreshUpcoming(song.videoId, chip.playlistId, generation);
    },
    [refreshUpcoming]
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

  // The release year arrives with the song-info request rather than the song
  // itself, so it lands a moment after playback starts.
  const applyReleaseYear = useCallback((videoId: string, year: string) => {
    setCurrentSong((song) => (song && song.videoId === videoId && song.year !== year ? { ...song, year } : song));
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
      const result = await PyBridge.getSongInfo(videoId);
      if (cancelled || request !== ratingRequestRef.current) return;
      if (!result.success) return;
      if (result.data?.likeStatus) applyLikeStatus(videoId, result.data.likeStatus);
      if (result.data?.year) applyReleaseYear(videoId, result.data.year);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyLikeStatus, applyReleaseYear, currentSong?.videoId]);

  // Lyrics drive the queue panel's Lyrics tab, so they are read as soon as the
  // song changes rather than when the tab is opened. The tab stays hidden until
  // this answers, which is also how a song with no lyrics keeps it hidden.
  useEffect(() => {
    const videoId = currentSong?.videoId;
    if (!videoId) return;
    const request = ++lyricsRequestRef.current;
    void PyBridge.getLyrics(videoId).then((result) => {
      if (request !== lyricsRequestRef.current) return;
      const data = result.success ? result.data : null;
      const text = data?.lyrics;
      setLyricsState(
        typeof text === "string" && text.trim()
          ? {
              videoId,
              text: text.trim(),
              source: data?.source ?? null,
              lines: Array.isArray(data?.lines) ? data.lines : [],
            }
          : null,
      );
    });
  }, [currentSong?.videoId]);

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
    async (playlistId: string, mode: "play" | "shuffle" | "mix", tunable?: boolean) => {
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
      queueTunerRef.current = "All";
      setQueueTuner("All");
      setQueueChips([]);

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

      // A playlist mix is a tunable automix; a plain album or playlist is not.
      // Callers can opt a fixed collection in explicitly (the artist song list).
      const tunerAllowed = tunable ?? mode === "mix";
      if (tunerAllowed && first.videoId) {
        void PyBridge.getQueueTuner(first.videoId).then((result) => {
          if (playGenerationRef.current !== generation) return;
          if (result.success && Array.isArray(result.data)) setQueueChips(result.data);
        });
      }
    },
    [loadWatchPlaylist]
  );

  const queuePlaylist = useCallback(async (playlistId: string, position: "next" | "end") => {
    if (!playlistId) return;
    // Queueing needs every track, so read the whole playlist instead of the
    // pages the view happens to have loaded.
    const result = await PyBridge.getPlaylistAllTracks(playlistId);
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

  const playTracks = useCallback((tracks: Track[], preserveOrder = false) => {
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
    if (!preserveOrder && shuffleRef.current) {
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

  /**
   * The true-random order for a list: `openerId` first, then every other
   * playable track permuted by Python's `SystemRandom` (OS CSPRNG). ``null``
   * when the shuffle call fails or the opener is not in the list.
   */
  const shuffledOrder = useCallback(
    async (openerId: string, tracks: Track[]): Promise<WatchTrack[] | null> => {
      const playable = tracks.filter((track) => track.videoId && track.isAvailable);
      const opener = playable.find((track) => track.videoId === openerId);
      if (!opener) return null;
      const rest = playable.filter((track) => track.videoId !== openerId);

      const result = await PyBridge.shuffleTracks(rest.map((track) => track.videoId));
      if (!result.success || !Array.isArray(result.data)) return null;
      const byId = new Map(rest.map((track) => [track.videoId, track]));
      const shuffled = result.data
        .map((videoId) => byId.get(videoId))
        .filter((track): track is Track => Boolean(track));
      const seen = new Set(shuffled.map((track) => track.videoId));
      const leftover = rest.filter((track) => !seen.has(track.videoId));
      return [opener, ...shuffled, ...leftover].map(trackToWatchTrack);
    },
    [],
  );

  /** Swap in a shuffled order, keeping `openerId` as the song that is playing. */
  const applyOrderedQueue = useCallback((openerId: string, ordered: WatchTrack[]) => {
    const index = ordered.findIndex((track) => track.videoId === openerId);
    queueRef.current = ordered;
    currentQueueIndexRef.current = index >= 0 ? index : 0;
    normalUpcomingRef.current = null;
    setQueue(ordered);
    setQueueIndex(currentQueueIndexRef.current);
    setQueueRevision((revision) => revision + 1);
  }, []);

  /**
   * Start a list in a true-random order.
   *
   * The opener is drawn from the browser CSPRNG and plays right away, then the
   * rest is permuted by Python's `SystemRandom` (OS CSPRNG) and swapped into the
   * queue while that first song plays. Drawing the opener first and shuffling the
   * remainder is still a uniform permutation of the whole list, and it starts
   * the audio without waiting on the shuffle round trip.
   */
  const trueShuffle = useCallback(
    async (tracks: Track[]) => {
      const playable = tracks.filter((track) => track.videoId && track.isAvailable);
      if (playable.length === 0) return;

      const openerIndex = secureRandomIndex(playable.length);
      const opener = playable[openerIndex];
      const rest = playable.filter((_, index) => index !== openerIndex);
      playTracks([opener, ...rest], true);

      const generation = playGenerationRef.current;
      const ordered = await shuffledOrder(opener.videoId, tracks);
      if (!ordered) return;
      // The user may have started something else while the shuffle was in flight.
      if (playGenerationRef.current !== generation || currentSongRef.current?.videoId !== opener.videoId) return;
      applyOrderedQueue(opener.videoId, ordered);
    },
    [applyOrderedQueue, playTracks, shuffledOrder],
  );

  /**
   * True-shuffle a playlist without waiting for the whole list.
   *
   * Reading every page of a long playlist takes a while, so the first page is
   * read first: one of those songs starts immediately and the page becomes the
   * queue. The rest of the list is read behind it, and the full shuffled order
   * replaces the queue when it arrives. The song that started it keeps playing
   * throughout, and a spinner sits on the Queue tab until then. A cache that
   * already holds every page skips the second read entirely.
   */
  const trueShufflePlaylist = useCallback(
    async (playlistId: string) => {
      if (!playlistId) return;
      const first = await PyBridge.getPlaylistItems(playlistId);
      if (!first.success || !Array.isArray(first.data?.tracks)) return;
      const opening = first.data.tracks.filter((track) => track.videoId && track.isAvailable);
      if (opening.length === 0) return;

      const openerIndex = secureRandomIndex(opening.length);
      const opener = opening[openerIndex];
      playTracks([opener, ...opening.filter((_, index) => index !== openerIndex)], true);

      const generation = playGenerationRef.current;
      const request = ++shuffleRequestRef.current;
      // Only a page-by-page read is slow enough to owe the user a spinner.
      const complete = first.data.nextToken == null;
      if (!complete) setShufflePendingFor(opener.videoId);
      try {
        let tracks = first.data.tracks;
        if (!complete) {
          const result = await PyBridge.getPlaylistAllTracks(playlistId);
          if (!result.success || !Array.isArray(result.data?.tracks)) return;
          tracks = result.data.tracks;
        }
        if (playGenerationRef.current !== generation || currentSongRef.current?.videoId !== opener.videoId) return;
        const ordered = await shuffledOrder(opener.videoId, tracks);
        if (!ordered) return;
        if (playGenerationRef.current !== generation || currentSongRef.current?.videoId !== opener.videoId) return;
        applyOrderedQueue(opener.videoId, ordered);
      } finally {
        if (shuffleRequestRef.current === request) setShufflePendingFor(null);
      }
    },
    [applyOrderedQueue, playTracks, shuffledOrder],
  );

  const reorderQueue = useCallback((from: number, to: number) => {
    const current = queueRef.current;
    const pinned = currentQueueIndexRef.current;
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return;
    const playing = pinned >= 0 ? current[pinned] : null;
    const next = moveItem(current, from, to);
    const nextIndex = playing ? next.indexOf(playing) : -1;
    queueRef.current = next;
    currentQueueIndexRef.current = nextIndex;
    if (normalUpcomingRef.current && nextIndex >= 0) normalUpcomingRef.current = next.slice(nextIndex + 1);
    setQueue(next);
    setQueueIndex(nextIndex);
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
    (track: Track, playlistId?: string, tunable?: boolean) => {
      // A removed or region-blocked track has no playable stream; starting it
      // just races the player into an error. The row stays for selection and
      // removal, but it never becomes the current song.
      if (!track.videoId || !track.isAvailable) return;
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
      void getWatchPlaylist(track.videoId, playlistId, false, false, track, tunable);
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
        lyrics,
        queue,
        queueOpen,
        queueLoading,
        queueTuner,
        queueChips,
        selectQueueTuner,
        toggleQueue,
        shuffle: shuffleOn,
        toggleShuffle,
        ratingPending,
        trackRatings,
        rateSong,
        rateTrack,
        getWatchPlaylist,
        playFromQueue,
        reorderQueue,
        playFromPlaylist,
        playTrackNext,
        addTrackToQueue,
        startMix,
        playPlaylist,
        queuePlaylist,
        playTracks,
        trueShuffle,
        trueShufflePlaylist,
        shufflePending,
        playNext,
        playPrevious,
        hasNext,
        hasPrevious,
        currentQueueIndex,
        queueRevision,
        queueFill,
        currentVideoId,
        videoOpen,
        toggleVideo,
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
