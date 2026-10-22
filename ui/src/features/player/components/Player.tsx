import { useState, useRef, useCallback, useEffect } from "react";
import { usePlayer } from "../context/PlayerContext";
import { playhead } from "../lib/playhead";
import { APP_EVENTS, type AppEvent } from "../lib/appEvents";
import { useToast } from "@/components/ui/Toast";
import { PyBridge } from "@/lib/api";
import type { Thumbnail, Track } from "@/lib/api/types";
import { PlayerControls } from "./PlayerControls";
import { PlayerProgress } from "./PlayerProgress";

const RESTART_THRESHOLD_SECONDS = 3;
const PRESENCE_SEEK_SECONDS = 3;
/** Wait for the slider to settle before writing the volume to disk. */
const VOLUME_SAVE_DELAY_MS = 400;

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
  const [elapsedTime, setElapsedTime] = useState(0);
  const { showToast } = useToast();
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  // The stream read in flight for the element, so a play press during it waits
  // for that read instead of starting a second one.
  const pendingLoadRef = useRef<{ videoId: string; request: number } | null>(null);
  const elapsedRef = useRef(0);
  const historyVideoIdRef = useRef<string | null>(null);
  const [volume, setVolume] = useState(50);
  const volumeRef = useRef(volume);
  const playingRef = useRef(false);
  const ignorePauseRef = useRef(false);
  const requestRef = useRef(0);
  const failedRef = useRef<string | null>(null);
  const lastSeekTime = useRef(0);
  const gain = sliderToGain(volume);
  volumeRef.current = volume;
  playingRef.current = isPlaying;
  elapsedRef.current = elapsedTime;

  const playAudio = useCallback((audio: HTMLAudioElement) => {
    void audio.play().then(() => {
      if (!playingRef.current) audio.pause();
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!playingRef.current) return;
      setIsPlaying(false);
    });
  }, []);

  const loadStream = useCallback((videoId: string, refresh = false) => {
    const request = ++requestRef.current;
    const audio = playerRef.current;
    if (!audio) return;
    pendingLoadRef.current = { videoId, request };
    ignorePauseRef.current = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    void PyBridge.getAudioStream(videoId, refresh).then((result) => {
      if (request !== requestRef.current) return;
      const node = playerRef.current;
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
      const level = sliderToGain(volumeRef.current);
      node.volume = level;
      node.muted = level === 0;
      node.src = result.data.url;
      ignorePauseRef.current = false;
      if (playingRef.current) playAudio(node);
    }).finally(() => {
      if (pendingLoadRef.current?.request === request) pendingLoadRef.current = null;
    });
  }, [playAudio, showToast]);

  const handleSeek = useCallback((time: number) => {
    const now = Date.now();
    if (now - lastSeekTime.current < 100) return;
    lastSeekTime.current = now;

    if (playerRef.current) {
      playerRef.current.currentTime = time;
    }
    playhead.set(time);
  }, []);

  // The lyrics panel seeks through playhead, which routes back here.
  useEffect(() => {
    playhead.setSeeker(handleSeek);
  }, [handleSeek]);

  const restart = useCallback(() => {
    if (playerRef.current) playerRef.current.currentTime = 0;
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

  const toggleLoop = useCallback(() => {
    setLoop((on) => !on);
  }, []);

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
      const audio = playerRef.current;
      if (audio) playAudio(audio);
      return;
    }
    void playNext().then((advanced) => {
      if (!advanced) {
        playingRef.current = false;
        setIsPlaying(false);
      }
    });
  }, [loop, playAudio, playNext, restart]);

  useEffect(() => {
    const song = currentSong;
    if (!song || !song.videoId) return;
    const videoId = song.videoId;
    setDuration(Number(song.durationSeconds));
    setElapsedTime(0);
    playhead.reset();
    failedRef.current = null;
    playingRef.current = true;
    setIsPlaying(true);
    loadStream(videoId);
  }, [currentSong?.videoId, loadStream]);

  useEffect(() => {
    const audio = playerRef.current;
    if (!audio) return;
    const level = gain;
    audio.volume = level;
    audio.muted = level === 0;
  }, [gain]);

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
    const audio = playerRef.current;
    if (!audio?.getAttribute("src")) return;
    if (isPlaying) playAudio(audio);
    else audio.pause();
  }, [isPlaying, playAudio]);

  useEffect(() => {
    const nextId = hasNext ? queue[currentQueueIndex + 1]?.videoId : null;
    if (!nextId || nextId === currentSong?.videoId) return;
    void PyBridge.getAudioStream(nextId);
  }, [currentQueueIndex, currentSong?.videoId, hasNext, queue]);

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
            const audio = playerRef.current;
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
          shuffle={shuffle}
          onToggleShuffle={toggleShuffle}
          loop={loop}
          onToggleLoop={toggleLoop}
          ratingPending={ratingPending}
          onRate={rateSong}
        />
      </div>
      <audio
        ref={playerRef}
        preload="auto"
        onPlay={() => {
          playingRef.current = true;
          // The embed can resume the audio on its own, so follow it instead of
          // trusting only the app's own play button.
          setIsPlaying(true);
        }}
        onPlaying={() => {
          // The play event fires before any byte has loaded, so a failed stream
          // would still be written to the account's history. Playing means
          // audio is actually flowing.
          if (currentSong) recordHistory(currentSong);
        }}
        onPause={() => {
          if (ignorePauseRef.current) return;
          const audio = playerRef.current;
          const length = audio?.duration ?? 0;
          const time = audio?.currentTime ?? 0;
          if (loop && length > 0 && time >= length - 0.25) return;
          playingRef.current = false;
          setIsPlaying(false);
        }}
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          setElapsedTime(time);
          playhead.set(time);
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onEnded={handleEnded}
        onError={() => {
          const audio = playerRef.current;
          const videoId = currentSong.videoId;
          if (!audio?.getAttribute("src") || !videoId) return;
          if (failedRef.current === videoId) {
            setIsPlaying(false);
            showToast("Playback failed", "error");
            return;
          }
          failedRef.current = videoId;
          loadStream(videoId, true);
        }}
      />
    </>
  );
};