import { useState, useRef, useCallback, useEffect, type AudioHTMLAttributes } from "react";
import { usePlayer } from "../context/PlayerContext";
import { playhead } from "../lib/playhead";
import { attachEqualizer, loadEqualizer } from "../lib/equalizer";
import { setActiveAudio } from "../lib/activeAudio";
import { rampVolumes, type Ramp } from "../lib/volumeRamp";
import { bytesFromBase64, tempoFromBytes, type Tempo } from "../lib/tempo";
import { playback } from "../lib/playback";
import { APP_EVENTS, type AppEvent } from "../lib/appEvents";
import { useToast } from "@/components/ui/Toast";
import { automixEnabled } from "@/lib/automix";
import { useCrossfadeSeconds } from "@/lib/crossfade";
import { PyBridge } from "@/lib/api";
import { closePopout, openPopout, usePopout } from "@/lib/popout";
import type { Thumbnail, Track } from "@/lib/api/types";
import { PlayerControls } from "./PlayerControls";
import { PlayerProgress } from "./PlayerProgress";

const RESTART_THRESHOLD_SECONDS = 3;
const PRESENCE_SEEK_SECONDS = 3;
/** Wait for the slider to settle before writing the volume to disk. */
const VOLUME_SAVE_DELAY_MS = 400;
/** How often the end of the song is measured, so a fade starts on time. */
const CROSSFADE_POLL_MS = 100;
/** Below this the overlap is a click rather than a blend; the song ends normally instead. */
const MIN_CROSSFADE_SECONDS = 0.75;
/** `readyState` at which a preloaded element can start without waiting for audio. */
const READY_TO_START = 2;

/** Playbar cap for the track title, in characters. Keeps the like buttons clear of the transport controls. */

const largestThumbnail = (thumbnails: Thumbnail[] | undefined) => {
  let best = "";
  let width = -1;
  for (const thumb of thumbnails ?? []) {
    if (!thumb.url) continue;
    const size = thumb.width || 0;
    if (size >= width) {
      width = size;
      best = thumb.url;
    }
  }
  return best;
};

// Square curve so the middle of the slider is quieter than a linear 50%.
const sliderToGain = (slider: number) => {
  const t = Math.min(100, Math.max(0, slider)) / 100;
  if (t === 0) return 0;
  return Math.max(0.01, Math.round(t * t * 100) / 100);
};

/** The fade in flight: the element leaving, and the one taking over from it. */
type Transfer = { from: number; to: number; ramp: Ramp | null };

export const Player = () => {
  const {
    currentSong,
    queueOpen,
    toggleQueue,
    playNext,
    playPrevious,
    hasNext,
    hasPrevious,
    queue,
    currentQueueIndex,
    shuffle,
    toggleShuffle,
    rateSong,
    ratingPending,
    currentVideoId,
    videoOpen,
    toggleVideo,
  } = usePlayer();
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const popout = usePopout();
  const [elapsedTime, setElapsedTime] = useState(0);
  const { showToast } = useToast();
  const [duration, setDuration] = useState(0);
  const elapsedRef = useRef(0);
  const historyVideoIdRef = useRef<string | null>(null);
  const [volume, setVolume] = useState(50);
  const playingRef = useRef(false);
  const ignorePauseRef = useRef(false);
  const requestRef = useRef(0);
  const failedRef = useRef<string | null>(null);
  const lastSeekTime = useRef(0);
  const gain = sliderToGain(volume);
  const gainRef = useRef(gain);
  // The stream read in flight for the element, so a play press during it waits
  // for that read instead of starting a second one.
  const pendingLoadRef = useRef<{ videoId: string; request: number } | null>(null);
  const crossfadeSeconds = useCrossfadeSeconds();
  // The beat-aligned blend is shelved (see lib/automix.ts); the plan in this
  // component stays dormant behind this constant false.
  const automix = automixEnabled();
  // Two elements take turns holding the current song. The idle one buffers the
  // next track, and a crossfade fades it in while the busy one fades out.
  const audioRefs = useRef<Array<HTMLAudioElement | null>>([null, null]);
  const activeIndexRef = useRef(0);
  const transferRef = useRef<Transfer | null>(null);
  /** The next song already buffered in the idle element, waiting for the hand-over to be committed. */
  const stagedRef = useRef<{ videoId: string; element: number; fadeSeconds: number; startAt?: number } | null>(null);
  /** A hand-over is decided but the player state has not caught up with it yet. */
  const handingOverRef = useRef(false);
  /** Songs whose preloaded stream failed, so staging does not keep retrying the same URL. */
  const unwarmableRef = useRef<Set<string>>(new Set());
  const [stageRevision, setStageRevision] = useState(0);
  const nextVideoIdRef = useRef<string | null>(null);
  const songVideoIdRef = useRef<string | null>(null);
  /** Beat estimates by video id; a null value means one was tried and rejected. */
  const tempoRef = useRef<Map<string, Tempo | null>>(new Map());
  const tempoPendingRef = useRef<Set<string>>(new Set());
  /** A blend waiting for the outgoing track's next beat. */
  const pendingFadeRef = useRef<number | null>(null);
  /** Measured start-up cost of a preloaded element, so a beat-aligned start is not late by it. */
  const playLatencyRef = useRef(0);
  const automixRef = useRef(automix);
  playingRef.current = isPlaying;
  elapsedRef.current = elapsedTime;
  gainRef.current = gain;
  automixRef.current = automix;
  nextVideoIdRef.current = hasNext ? (queue[currentQueueIndex + 1]?.videoId ?? null) : null;
  songVideoIdRef.current = currentSong?.videoId ?? null;

  const isCurrent = (node: EventTarget | null) => node === audioRefs.current[activeIndexRef.current];

  const applyMasterVolume = useCallback((level: number) => {
    for (const node of audioRefs.current) {
      if (!node) continue;
      node.volume = level;
      node.muted = level === 0;
    }
  }, []);

  /** Makes an element the one carrying the current song, for anything that syncs to it. */
  const activate = useCallback(
    (index: number) => {
      activeIndexRef.current = index;
      setActiveAudio(audioRefs.current[index]);
      // The elements mount with the first song, after the volume effect has run.
      applyMasterVolume(gainRef.current);
    },
    [applyMasterVolume],
  );

  /** Silences and releases an element, so a finished song holds no buffer. */
  const releaseElement = useCallback((index: number) => {
    const node = audioRefs.current[index];
    if (!node) return;
    node.volume = 0;
    node.pause();
    node.removeAttribute("src");
    node.load();
    node.dataset.videoId = "";
  }, []);

  /**
   * The equal-power pair: the two gains square to one through the blend, so the
   * loudness holds steady where a linear pair would dip in the middle.
   */
  const applyFade = useCallback((progress: number) => {
    const transfer = transferRef.current;
    if (!transfer) return;
    const master = gainRef.current;
    const out = audioRefs.current[transfer.from];
    const into = audioRefs.current[transfer.to];
    if (out) {
      out.volume = master * Math.cos((progress * Math.PI) / 2);
      out.muted = master === 0;
    }
    if (into) {
      into.volume = master * Math.sin((progress * Math.PI) / 2);
      into.muted = master === 0;
    }
  }, []);

  /**
   * Fades `from` out and `to` in over `fadeSeconds`, then drops `from`. A zero
   * length is a hard swap: `to` is already playing, so it needs no ramp.
   *
   * The length is taken from what the outgoing file actually has left, so a
   * late start (a beat, a poll tick) shortens the blend instead of leaving the
   * old song silent before its own end.
   */
  const startTransfer = useCallback(
    (from: number, to: number, fadeSeconds: number) => {
      const outgoing = audioRefs.current[from];
      const left =
        outgoing && Number.isFinite(outgoing.duration) ? outgoing.duration - outgoing.currentTime : Infinity;
      const length = Math.max(0, Math.min(fadeSeconds, left));
      const transfer: Transfer = { from, to, ramp: null };
      transferRef.current = transfer;
      const into = audioRefs.current[to];
      if (into) {
        into.volume = length > 0 ? 0 : gainRef.current;
        into.muted = gainRef.current === 0;
      }
      transfer.ramp = rampVolumes({
        lengthMs: length * 1000,
        onFrame: applyFade,
        onComplete: () => {
          if (transferRef.current !== transfer) return;
          transferRef.current = null;
          releaseElement(from);
          applyMasterVolume(gainRef.current);
          setStageRevision((revision) => revision + 1);
        },
      });
    },
    [applyFade, applyMasterVolume, releaseElement],
  );

  /** Drops a blend that is still running, leaving the incoming song untouched. */
  const endTransfer = useCallback(() => {
    const transfer = transferRef.current;
    if (!transfer) return;
    transferRef.current = null;
    transfer.ramp?.cancel();
    releaseElement(transfer.from);
    applyMasterVolume(gainRef.current);
    setStageRevision((revision) => revision + 1);
  }, [applyMasterVolume, releaseElement]);

  // The equalizer owns the audio graph per element, so it has to see the node
  // before the first stream is assigned to it.
  const bindAudio = (index: number) => (node: HTMLAudioElement | null) => {
    audioRefs.current[index] = node;
    if (node) attachEqualizer(node);
  };

  useEffect(() => {
    void loadEqualizer();
  }, []);

  const playAudio = useCallback((audio: HTMLAudioElement) => {
    const started = performance.now();
    void audio.play().then(() => {
      // play() settles once the element has actually started, which is what a
      // beat-aligned hand-over has to allow for. Smoothed, because one sample
      // is mostly scheduler noise.
      playLatencyRef.current = playLatencyRef.current * 0.7 + (performance.now() - started) * 0.3;
      if (!playingRef.current) audio.pause();
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!playingRef.current) return;
      setIsPlaying(false);
    });
  }, []);

  const loadStream = useCallback((videoId: string, refresh = false) => {
    const request = ++requestRef.current;
    const audio = audioRefs.current[activeIndexRef.current];
    if (!audio) return;
    pendingLoadRef.current = { videoId, request };
    ignorePauseRef.current = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audio.dataset.videoId = videoId;
    void PyBridge.getAudioStream(videoId, refresh).then((result) => {
      if (request !== requestRef.current) return;
      const node = audioRefs.current[activeIndexRef.current];
      if (!node) return;
      if (!result.success) {
        ignorePauseRef.current = false;
        setIsPlaying(false);
        showToast(result.error.message || "Could not play this song", "error");
        return;
      }
      if (!result.data.url) {
        ignorePauseRef.current = false;
        setIsPlaying(false);
        showToast("Could not play this song", "error");
        return;
      }
      node.volume = gainRef.current;
      node.muted = gainRef.current === 0;
      node.src = result.data.url;
      ignorePauseRef.current = false;
      if (playingRef.current) playAudio(node);
    }).finally(() => {
      if (pendingLoadRef.current?.request === request) pendingLoadRef.current = null;
    });
  }, [playAudio, showToast]);

  /** The idle element, if it is holding the next track ready to start. */
  const stagedElement = useCallback((): number | null => {
    const nextId = nextVideoIdRef.current;
    // The same song twice in a row would leave the hand-over with nothing to
    // react to, since the player state would not change at all.
    if (!nextId || nextId === songVideoIdRef.current || transferRef.current) return null;
    const element = 1 - activeIndexRef.current;
    const spare = audioRefs.current[element];
    if (!spare || spare.dataset.videoId !== nextId || spare.readyState < READY_TO_START) return null;
    return element;
  }, []);

  /**
   * Advance to the next queued song through the element that already holds it.
   *
   * The song queued here is committed to the player state, so every reader of
   * `currentSong` moves with the audio: the title, lyrics, history and the
   * media keys all switch where the blend starts, the way they would if the
   * next song had simply started.
   */
  const handOver = useCallback(
    async (fadeSeconds: number, startAt = 0): Promise<boolean> => {
      if (handingOverRef.current) return false;
      const nextId = nextVideoIdRef.current;
      const element = stagedElement();
      if (!nextId || element === null) return false;
      handingOverRef.current = true;
      stagedRef.current = { videoId: nextId, element, fadeSeconds, startAt };
      const advanced = await playNext();
      if (!advanced) {
        stagedRef.current = null;
        handingOverRef.current = false;
      }
      return advanced;
    },
    [playNext, stagedElement],
  );

  /** Drops a blend that is still waiting for its beat. */
  const cancelPendingFade = useCallback(() => {
    if (pendingFadeRef.current === null) return;
    window.clearTimeout(pendingFadeRef.current);
    pendingFadeRef.current = null;
  }, []);

  /**
   * Reads a song's beat once, from the cache when it has been measured before.
   *
   * Best effort by design: a song with no usable estimate keeps the plain
   * crossfade, and the attempt is not repeated this session.
   */
  const ensureTempo = useCallback(async (videoId: string | null) => {
    if (!videoId) return;
    if (tempoRef.current.has(videoId) || tempoPendingRef.current.has(videoId)) return;
    tempoPendingRef.current.add(videoId);
    try {
      const stored = await PyBridge.getSongTempo(videoId);
      if (stored.success && stored.data) {
        // A stored estimate passed the gate when it was measured.
        tempoRef.current.set(videoId, { ...stored.data, confidence: 1 });
        return;
      }
      const sample = await PyBridge.getAudioSample(videoId);
      if (!sample.success || !sample.data?.data) {
        tempoRef.current.set(videoId, null);
        return;
      }
      const tempo = await tempoFromBytes(bytesFromBase64(sample.data.data));
      tempoRef.current.set(videoId, tempo);
      if (tempo) void PyBridge.storeSongTempo(videoId, tempo.bpm, tempo.offset);
    } catch {
      tempoRef.current.set(videoId, null);
    } finally {
      tempoPendingRef.current.delete(videoId);
    }
  }, []);

  /**
   * Start a blend before the song ends. The overlap is measured from what the
   * file has left rather than from the setting, so the fade reaches silence
   * exactly where the old song finishes; a poll or a seek can only shorten it.
   *
   * With automix on and a beat for this song, the blend waits for the next beat
   * and the incoming song enters on its own, so both sides of the change land on
   * a beat instead of wherever the clock happened to be.
   */
  const startCrossfade = useCallback(() => {
    const audio = audioRefs.current[activeIndexRef.current];
    if (!audio) return;
    const total = audio.duration;
    if (!Number.isFinite(total) || total <= 0) return;
    const remaining = total - audio.currentTime;
    const fade = Math.min(crossfadeSeconds, remaining);
    if (fade < MIN_CROSSFADE_SECONDS) return;

    const tempo = automixRef.current && currentSong ? (tempoRef.current.get(currentSong.videoId) ?? null) : null;
    if (tempo) {
      const period = 60 / tempo.bpm;
      // Seconds until the outgoing track's next beat.
      const since = audio.currentTime - tempo.offset;
      const untilBeat = (((period - (since % period)) % period) + period) % period;
      const blend = Math.min(fade, remaining - untilBeat);
      if (blend >= MIN_CROSSFADE_SECONDS) {
        const nextId = nextVideoIdRef.current;
        const incoming = nextId ? (tempoRef.current.get(nextId) ?? null) : null;
        // Enter on the incoming song's own beat too, but never skip more than
        // one beat of its intro to get there.
        const startAt = incoming ? Math.min(incoming.offset, 60 / incoming.bpm) : 0;
        const delay = Math.max(0, untilBeat * 1000 - playLatencyRef.current);
        if (delay < 20) {
          void handOver(blend, startAt);
        } else {
          pendingFadeRef.current = window.setTimeout(() => {
            pendingFadeRef.current = null;
            void handOver(blend, startAt);
          }, delay);
        }
        return;
      }
    }
    void handOver(fade);
  }, [crossfadeSeconds, currentSong, handOver]);

  const handleSeek = useCallback((time: number) => {
    const now = Date.now();
    if (now - lastSeekTime.current < 100) return;
    lastSeekTime.current = now;

    // Seeking the new song while the old one is still fading out would leave
    // the blend running over a jump, so the tail goes now.
    cancelPendingFade();
    endTransfer();
    const audio = audioRefs.current[activeIndexRef.current];
    if (audio) audio.currentTime = time;
    playhead.set(time);
  }, [cancelPendingFade, endTransfer]);

  // The lyrics panel seeks through playhead, which routes back here.
  useEffect(() => {
    playhead.setSeeker(handleSeek);
  }, [handleSeek]);

  const restart = useCallback(() => {
    const audio = audioRefs.current[activeIndexRef.current];
    if (audio) audio.currentTime = 0;
    setElapsedTime(0);
    playhead.reset();
  }, []);

  const handlePrevious = useCallback(() => {
    if (elapsedRef.current > RESTART_THRESHOLD_SECONDS) {
      restart();
      return;
    }
    playPrevious();
  }, [playPrevious, restart]);

  const handleNext = useCallback(() => {
    playNext();
  }, [playNext]);

  const playingVideoId = currentSong?.videoId ?? null;

  const handlePlay = useCallback(() => {
    playingRef.current = true;
    setIsPlaying(true);
    const audio = audioRefs.current[activeIndexRef.current];
    const pending = pendingLoadRef.current;
    // A stream already on its way starts on its own when it lands. Asking
    // again here threw it away and began a second read, so the first song
    // of a session played only after the user pressed play twice.
    if (audio && !audio.getAttribute("src") && playingVideoId && pending?.videoId !== playingVideoId) {
      loadStream(playingVideoId, true);
    }
  }, [playingVideoId, loadStream]);

  const handlePause = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
  }, []);

  const toggleLoop = useCallback(() => {
    setLoop((on) => !on);
  }, []);

  // The popout sends play, seek and next through these, so it drives this
  // window's audio instead of starting a second player of its own.
  useEffect(() => {
    playback.setTransport({
      play: handlePlay,
      pause: handlePause,
      seek: handleSeek,
      next: handleNext,
      previous: handlePrevious,
      toggleLoop,
    });
    return () => playback.setTransport(null);
  }, [handleNext, handlePause, handlePlay, handlePrevious, handleSeek, toggleLoop]);

  useEffect(() => {
    playback.publish({ playing: isPlaying });
  }, [isPlaying]);

  useEffect(() => {
    playback.publish({ duration });
  }, [duration]);

  useEffect(() => {
    playback.publish({ loop });
  }, [loop]);

  const recordHistory = useCallback((song: Track) => {
    if (!song.videoId || song.videoType !== "MUSIC_VIDEO_TYPE_ATV") return;
    if (historyVideoIdRef.current === song.videoId) return;
    historyVideoIdRef.current = song.videoId;
    void PyBridge.addSongToHistory(song.videoId).then((result) => {
      if (!result.success && historyVideoIdRef.current === song.videoId) {
        historyVideoIdRef.current = null;
      }
    });
  }, []);

  const handleEnded = useCallback(() => {
    if (loop) {
      restart();
      playingRef.current = true;
      setIsPlaying(true);
      const audio = audioRefs.current[activeIndexRef.current];
      if (audio) playAudio(audio);
      return;
    }
    // A preloaded next track swaps in on the same tick this one ends, so what
    // is left between songs is the player's start latency, not a network round
    // trip. Without one, the next stream is resolved as it always was.
    const element = stagedElement();
    const nextId = nextVideoIdRef.current;
    if (element !== null && nextId) {
      handingOverRef.current = true;
      stagedRef.current = { videoId: nextId, element, fadeSeconds: 0 };
    }
    void playNext().then((advanced) => {
      if (!advanced) {
        stagedRef.current = null;
        handingOverRef.current = false;
        playingRef.current = false;
        setIsPlaying(false);
      }
    });
  }, [loop, playAudio, playNext, restart, stagedElement]);

  // A song change either lands in the idle element that is already buffering it
  // or loads into the active one. Either way the song before it stops here.
  useEffect(() => {
    const song = currentSong;
    if (!song?.videoId) return;
    const staged = stagedRef.current;
    stagedRef.current = null;
    handingOverRef.current = false;
    cancelPendingFade();
    setDuration(Number(song.durationSeconds));
    setElapsedTime(0);
    playhead.reset();
    failedRef.current = null;
    playingRef.current = true;
    setIsPlaying(true);

    if (staged && staged.videoId === song.videoId && staged.element !== activeIndexRef.current) {
      const from = activeIndexRef.current;
      const into = audioRefs.current[staged.element];
      if (into) {
        // A load still in flight belongs to the element being retired.
        requestRef.current += 1;
        ignorePauseRef.current = false;
        // Entering on a beat means starting a little way into the track, which
        // has to happen before it is told to play.
        if (staged.startAt) into.currentTime = staged.startAt;
        activate(staged.element);
        startTransfer(from, staged.element, staged.fadeSeconds);
        playAudio(into);
        return;
      }
    }

    endTransfer();
    activate(activeIndexRef.current);
    loadStream(song.videoId);
  }, [activate, cancelPendingFade, currentSong?.videoId, endTransfer, loadStream, playAudio, startTransfer]);

  // The song ending under a blend would otherwise be noticed twice, by the
  // timer and by the element, so only the timer starts one.
  useEffect(() => {
    if (!isPlaying) return;
    const timer = window.setInterval(() => {
      if (!playingRef.current || handingOverRef.current || transferRef.current) return;
      if (crossfadeSeconds <= 0 || loop) return;
      const audio = audioRefs.current[activeIndexRef.current];
      if (!audio || audio.paused) return;
      const total = audio.duration;
      if (!Number.isFinite(total) || total <= 0) return;
      if (total - audio.currentTime > crossfadeSeconds) return;
      startCrossfade();
    }, CROSSFADE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      // A blend that was waiting for its beat must not fire after the pause,
      // seek or setting change that ended this poll.
      cancelPendingFade();
    };
  }, [cancelPendingFade, crossfadeSeconds, isPlaying, loop, startCrossfade]);

  // Read the beat of the playing song and the one after it, off the playback
  // path: a measured song costs one small cache call, a new one costs a prefix
  // of its stream once, ever.
  useEffect(() => {
    if (!automix) return;
    void ensureTempo(currentSong?.videoId ?? null);
    void ensureTempo(nextVideoIdRef.current);
  }, [automix, currentQueueIndex, currentSong?.videoId, ensureTempo, queue]);

  // Buffer the next track while this one plays. A blend in flight has both
  // elements in use, so staging waits for the revision bump that ends it.
  useEffect(() => {
    if (transferRef.current) return;
    const nextId = nextVideoIdRef.current;
    if (!nextId || nextId === currentSong?.videoId) return;
    if (unwarmableRef.current.has(nextId)) return;
    const index = 1 - activeIndexRef.current;
    const spare = audioRefs.current[index];
    if (!spare || spare.dataset.videoId === nextId) return;
    let cancelled = false;
    void PyBridge.getAudioStream(nextId).then((result) => {
      const url = result.success ? result.data?.url : "";
      if (cancelled || !url) return;
      // The queue can move on while the URL is being resolved.
      if (nextVideoIdRef.current !== nextId) return;
      const node = audioRefs.current[index];
      if (!node || node.dataset.videoId === nextId) return;
      node.dataset.videoId = nextId;
      node.src = url;
      node.load();
    });
    return () => {
      cancelled = true;
    };
  }, [currentQueueIndex, currentSong?.videoId, queue, stageRevision]);

  useEffect(() => {
    setActiveAudio(audioRefs.current[activeIndexRef.current]);
    return () => {
      setActiveAudio(null);
      transferRef.current?.ramp?.cancel();
      if (pendingFadeRef.current !== null) window.clearTimeout(pendingFadeRef.current);
    };
  }, []);

  useEffect(() => {
    // A blend picks the new level up on its next frame.
    if (transferRef.current) return;
    applyMasterVolume(gain);
  }, [applyMasterVolume, gain]);

  useEffect(() => {
    const audio = audioRefs.current[activeIndexRef.current];
    if (!audio?.getAttribute("src")) return;
    if (isPlaying) playAudio(audio);
    else audio.pause();
  }, [isPlaying, playAudio]);

  // Volume is saved by Python: the packaged page's localhost port changes per launch, so localStorage would not stick.
  const volumeLoadedRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void PyBridge.getVolume().then((result) => {
      if (cancelled) return;
      if (result.success && typeof result.data === "number") setVolume(result.data);
      volumeLoadedRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!volumeLoadedRef.current) return;
    const timer = window.setTimeout(() => void PyBridge.setVolume(volume), VOLUME_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [volume]);

  useEffect(() => {
    const artist = currentSong?.artists.map((item) => item.name).join(", ") ?? "";
    const artwork = currentSong?.thumbnails?.[0]?.url ?? "";
    void PyBridge.updateMediaControls(
      currentSong?.title ?? "",
      artist,
      Boolean(currentSong) && isPlaying,
      hasNext,
      artwork
    );
  }, [currentSong, isPlaying, hasNext]);

  const presenceRef = useRef({
    songId: "",
    title: "",
    artist: "",
    album: "",
    artwork: "",
    playing: false,
    elapsed: 0,
    duration: 0,
    sentAt: 0,
  });

  // Discord draws its own progress bar from the timestamp. Resend when the song,
  // play state, or position jumps. Ordinary playback ticks stay on this page.
  useEffect(() => {
    const songId = currentSong?.videoId ?? "";
    const title = currentSong?.title ?? "";
    const artist = currentSong?.artists.map((item) => item.name).filter(Boolean).join(", ") ?? "";
    const album = currentSong?.album?.name ?? "";
    const artwork = largestThumbnail(currentSong?.thumbnails);
    const listed = Number(currentSong?.durationSeconds) || 0;
    const prev = presenceRef.current;
    const songChanged = prev.songId !== songId;
    const playing = songId ? (songChanged ? true : isPlaying) : false;
    const elapsed = songChanged ? 0 : elapsedTime;
    const length = songChanged || duration <= 0 ? listed : duration;
    const now = Date.now();
    const expected = prev.elapsed + (prev.playing ? (now - prev.sentAt) / 1000 : 0);
    const detailsChanged =
      prev.title !== title || prev.artist !== artist || prev.album !== album || prev.artwork !== artwork;
    const playChanged = prev.playing !== playing;
    const seeked = !songChanged && songId !== "" && Math.abs(elapsed - expected) > PRESENCE_SEEK_SECONDS;
    const durationChanged = !songChanged && songId !== "" && Math.abs(length - prev.duration) > 1;
    if (!songChanged && !detailsChanged && !playChanged && !seeked && !durationChanged) return;

    presenceRef.current = { songId, title, artist, album, artwork, playing, elapsed, duration: length, sentAt: now };
    void PyBridge.updateDiscordPresence(title, artist, album, playing, elapsed, length, artwork, songId);
  }, [currentSong, isPlaying, elapsedTime, duration]);

  useEffect(() => {
    window.pythonEvent = (action: string) => {
      if (!APP_EVENTS.includes(action as AppEvent)) return;
      const event = action as AppEvent;
      if (event === "play") {
        playingRef.current = true;
        setIsPlaying(true);
      } else if (event === "pause") {
        playingRef.current = false;
        setIsPlaying(false);
      } else if (event === "next") handleNext();
      else if (event === "previous") handlePrevious();
    };
    return () => {
      window.pythonEvent = undefined;
    };
  }, [handleNext, handlePrevious]);

  if (!currentSong) return null;

  const audioEvents: AudioHTMLAttributes<HTMLAudioElement> = {
    onPlay: (event) => {
      if (!isCurrent(event.currentTarget)) return;
      playingRef.current = true;
      // The embed can resume the audio on its own, so follow it instead of
      // trusting only the app's own play button.
      setIsPlaying(true);
    },
    onPlaying: (event) => {
      // The play event fires before any byte has loaded, so a failed stream
      // would still be written to the account's history. Playing means
      // audio is actually flowing.
      if (!isCurrent(event.currentTarget)) return;
      if (currentSong) recordHistory(currentSong);
    },
    onPause: (event) => {
      if (!isCurrent(event.currentTarget)) return;
      if (ignorePauseRef.current) return;
      const audio = event.currentTarget;
      const length = audio.duration;
      const time = audio.currentTime;
      if (loop && length > 0 && time >= length - 0.25) return;
      // Pausing mid-blend takes the old song with it; resuming plays the new
      // one alone rather than reviving a half-faded tail.
      cancelPendingFade();
      endTransfer();
      playingRef.current = false;
      setIsPlaying(false);
    },
    onTimeUpdate: (event) => {
      if (!isCurrent(event.currentTarget)) return;
      const time = event.currentTarget.currentTime;
      setElapsedTime(time);
      playhead.set(time);
      playback.publish({ position: time });
    },
    onDurationChange: (event) => {
      if (!isCurrent(event.currentTarget)) return;
      setDuration(event.currentTarget.duration);
    },
    onEnded: (event) => {
      if (!isCurrent(event.currentTarget)) return;
      handleEnded();
    },
    onError: (event) => {
      const node = event.currentTarget;
      const index = node === audioRefs.current[0] ? 0 : 1;
      if (!isCurrent(node)) {
        // A tail is on its way out anyway. A preload that cannot be fetched is
        // dropped for this session, so that song is loaded the ordinary way
        // when it comes up instead of being fetched in a loop.
        if (transferRef.current?.from === index) return;
        const failedId = node.dataset.videoId;
        if (failedId) unwarmableRef.current.add(failedId);
        node.dataset.videoId = "";
        setStageRevision((revision) => revision + 1);
        return;
      }
      const videoId = currentSong.videoId;
      if (!node.getAttribute("src") || !videoId) return;
      if (failedRef.current === videoId) {
        setIsPlaying(false);
        showToast("Playback failed", "error");
        return;
      }
      failedRef.current = videoId;
      loadStream(videoId, true);
    },
  };

  return (
    <>
      <div data-player-bar className="relative p-1.5 pt-2 bg-primary">
        <PlayerProgress currentTime={elapsedTime} duration={duration} onSeek={handleSeek} />
        <PlayerControls
          currentSong={currentSong}
          volume={volume}
          setVolume={setVolume}
          onPlay={() => {
            playingRef.current = true;
            setIsPlaying(true);
            const audio = audioRefs.current[activeIndexRef.current];
            const pending = pendingLoadRef.current;
            // A stream already on its way starts on its own when it lands. Asking
            // again here threw it away and began a second read, so the first song
            // of a session played only after the user pressed play twice.
            if (
              audio &&
              !audio.getAttribute("src") &&
              currentSong.videoId &&
              pending?.videoId !== currentSong.videoId
            ) {
              loadStream(currentSong.videoId, true);
            }
          }}
          onPause={() => {
            playingRef.current = false;
            setIsPlaying(false);
          }}
          onNext={handleNext}
          onPrevious={handlePrevious}
          isPlaying={isPlaying}
          canNext={hasNext}
          canPrevious={hasPrevious || elapsedTime > RESTART_THRESHOLD_SECONDS}
          queueOpen={queueOpen}
          onToggleQueue={toggleQueue}
          hasVideo={Boolean(currentVideoId)}
          videoOpen={videoOpen}
          onToggleVideo={toggleVideo}
          popoutOpen={popout.open}
          onTogglePopout={() => void (popout.open ? closePopout() : openPopout())}
          shuffle={shuffle}
          onToggleShuffle={toggleShuffle}
          loop={loop}
          onToggleLoop={toggleLoop}
          ratingPending={ratingPending}
          onRate={rateSong}
        />
      </div>
      <audio
        ref={bindAudio(0)}
        crossOrigin="anonymous"
        preload="auto"
        {...audioEvents}
      />
      <audio
        ref={bindAudio(1)}
        crossOrigin="anonymous"
        preload="auto"
        {...audioEvents}
      />
    </>
  );
};
