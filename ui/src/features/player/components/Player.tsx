import { useState, useRef, useCallback, useEffect, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { Link, useLocation } from "wouter";
import { usePlayer } from "../context/PlayerContext";
import { IconButton } from "@/components/ui/IconButton";
import { PyBridge } from "@/lib/api";
import { cn } from "@/util/cn";
import type { LikeStatus, Thumbnail, Track } from "@/lib/api/types";

const followLink = (event: MouseEvent<HTMLAnchorElement>, href: string, navigate: (to: string) => void) => {
  event.preventDefault();
  event.stopPropagation();
  navigate(href);
};

const RESTART_THRESHOLD_SECONDS = 3;
const PRESENCE_SEEK_SECONDS = 3;

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
  } = usePlayer();
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<HTMLAudioElement | null>(null);
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
    ignorePauseRef.current = true;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    void PyBridge.getAudioStream(videoId, refresh).then((result) => {
      if (request !== requestRef.current) return;
      const node = playerRef.current;
      if (!node) return;
      if (!result.success || !result.data.url) {
        ignorePauseRef.current = false;
        setIsPlaying(false);
        return;
      }
      const level = sliderToGain(volumeRef.current);
      node.volume = level;
      node.muted = level === 0;
      node.src = result.data.url;
      ignorePauseRef.current = false;
      if (playingRef.current) playAudio(node);
    });
  }, [playAudio]);

  const handleSeek = useCallback((time: number) => {
    const now = Date.now();
    if (now - lastSeekTime.current < 100) return;
    lastSeekTime.current = now;

    if (playerRef.current) {
      playerRef.current.currentTime = time;
    }
  }, []);

  const restart = useCallback(() => {
    if (playerRef.current) playerRef.current.currentTime = 0;
    setElapsedTime(0);
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
      if (action === "play") {
        playingRef.current = true;
        setIsPlaying(true);
      } else if (action === "pause") {
        playingRef.current = false;
        setIsPlaying(false);
      } else if (action === "next") handleNext();
      else if (action === "previous") handlePrevious();
    };
    return () => {
      window.pythonEvent = undefined;
    };
  }, [handleNext, handlePrevious]);

  if (!currentSong) return null;

  return (
    <>
      <div className="relative p-1.5 pt-2 bg-primary">
        <PlayerProgress currentTime={elapsedTime} duration={duration} onSeek={handleSeek} />
        <PlayerControls
          currentSong={currentSong}
          volume={volume}
          setVolume={setVolume}
          onPlay={() => {
            playingRef.current = true;
            setIsPlaying(true);
            const audio = playerRef.current;
            if (audio && !audio.getAttribute("src") && currentSong.videoId) loadStream(currentSong.videoId, true);
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
        onTimeUpdate={(event) => setElapsedTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onEnded={handleEnded}
        onError={() => {
          const audio = playerRef.current;
          const videoId = currentSong.videoId;
          if (!audio?.getAttribute("src") || !videoId) return;
          if (failedRef.current === videoId) {
            setIsPlaying(false);
            return;
          }
          failedRef.current = videoId;
          loadStream(videoId, true);
        }}
      />
    </>
  );
};

const RatingButtons = ({
  likeStatus,
  pending,
  onRate,
}: {
  likeStatus: LikeStatus;
  pending: boolean;
  onRate: (rating: LikeStatus) => void;
}) => (
  <>
    <IconButton
      iconClass={likeStatus === "LIKE" ? "icon-[solar--like-bold]" : "icon-[solar--like-linear]"}
      label="Like"
      size="md"
      tone="ghost"
      iconScale="secondary"
      disabled={pending}
      onClick={() => onRate("LIKE")}
    />
    <IconButton
      iconClass={likeStatus === "DISLIKE" ? "icon-[solar--dislike-bold]" : "icon-[solar--dislike-linear]"}
      label="Dislike"
      size="md"
      tone={likeStatus === "DISLIKE" ? "active" : "ghost"}
      iconScale="secondary"
      disabled={pending}
      onClick={() => onRate("DISLIKE")}
    />
  </>
);

const PlayerControls = ({
  currentSong,
  volume,
  setVolume,
  onPlay,
  onPause,
  onNext,
  onPrevious,
  isPlaying,
  canNext,
  canPrevious,
  queueOpen,
  onToggleQueue,
  shuffle,
  onToggleShuffle,
  loop,
  onToggleLoop,
  ratingPending,
  onRate,
}: {
  currentSong: Track;
  volume: number;
  setVolume: (volume: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  isPlaying: boolean;
  canNext: boolean;
  canPrevious: boolean;
  queueOpen: boolean;
  onToggleQueue: () => void;
  shuffle: boolean;
  onToggleShuffle: () => void;
  loop: boolean;
  onToggleLoop: () => void;
  ratingPending: boolean;
  onRate: (rating: LikeStatus) => void;
}) => {
  const likeStatus = currentSong.likeStatus ?? "INDIFFERENT";
  const [, navigate] = useLocation();
  const albumName = currentSong.album?.name;
  const albumId = currentSong.album?.id;
  const trackTitle = () => (
    <>
      <span className="block truncate text-sm text-primary">{currentSong.title}</span>
      <span className="block truncate text-sm text-primary-dark">
        {currentSong.artists.map((artist, index) => (
          <span key={`${artist.id}-${artist.name}-${index}`}>
            {index > 0 && ", "}
            {artist.id ? (
              <Link
                href={`/artist/${artist.id}`}
                onClick={(event) => followLink(event, `/artist/${artist.id}`, navigate)}
                className="hover:underline"
              >
                {artist.name}
              </Link>
            ) : (
              artist.name
            )}
          </span>
        ))}
        {albumName && (
          <>
            {currentSong.artists.length > 0 && <span aria-hidden="true"> • </span>}
            {albumId ? (
              <Link
                href={`/album/${albumId}`}
                onClick={(event) => followLink(event, `/album/${albumId}`, navigate)}
                className="hover:underline"
              >
                {albumName}
              </Link>
            ) : (
              albumName
            )}
          </>
        )}
      </span>
    </>
  );

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] col-span-2 items-center">
      <div className="flex min-w-0 items-center">
        <div className="group/track relative flex w-fit max-w-full items-center gap-1.5">
          <img src={currentSong.thumbnails[0].url} alt="" className="h-12 w-12 shrink-0 rounded-md" />
          <div className="relative min-w-0 max-md:min-w-24">
            <div className="min-w-0 max-md:hidden">{trackTitle()}</div>
            <div
              className={cn(
                "hidden min-w-0 transition-opacity duration-200 ease-out max-md:block",
                "group-hover/track:opacity-0 group-focus-within/track:opacity-0"
              )}
            >
              {trackTitle()}
            </div>
            <div
              className={cn(
                "pointer-events-none absolute inset-y-0 left-0 z-10 hidden translate-x-4 items-center gap-1 opacity-0 transition-[opacity,translate] duration-200 ease-out max-md:flex",
                "group-hover/track:pointer-events-auto group-hover/track:translate-x-0 group-hover/track:opacity-100",
                "group-focus-within/track:pointer-events-auto group-focus-within/track:translate-x-0 group-focus-within/track:opacity-100"
              )}
            >
              <RatingButtons likeStatus={likeStatus} pending={ratingPending} onRate={onRate} />
            </div>
          </div>
          <div className="flex items-center gap-1 pl-3 max-md:hidden">
            <RatingButtons likeStatus={likeStatus} pending={ratingPending} onRate={onRate} />
          </div>
        </div>
      </div>
      <div className="flex gap-1 items-center">
        <IconButton
          iconClass="icon-[solar--skip-previous-bold]"
          label="Previous"
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onPrevious}
          disabled={!canPrevious}
        />
        <IconButton
          iconClass={isPlaying ? "icon-[solar--pause-bold]" : "icon-[solar--play-bold]"}
          label={isPlaying ? "Pause" : "Play"}
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={isPlaying ? onPause : onPlay}
        />
        <IconButton
          iconClass="icon-[solar--skip-next-bold]"
          label="Next"
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onNext}
          disabled={!canNext}
        />
      </div>
      <div className="flex gap-1 items-center justify-self-end pr-3">
        <IconButton
          iconClass="icon-[solar--shuffle-linear]"
          label="Shuffle"
          size="md"
          tone={shuffle ? "active" : "ghost"}
          iconScale="transport"
          onClick={onToggleShuffle}
        />
        <IconButton
          iconClass={loop ? "icon-[solar--repeat-one-minimalistic-linear]" : "icon-[solar--repeat-linear]"}
          label="Loop"
          size="md"
          tone={loop ? "active" : "ghost"}
          iconScale="transport"
          onClick={onToggleLoop}
        />
        <VolumeControl volume={volume} setVolume={setVolume} />
        <IconButton
          iconClass={cn(
            "icon-[solar--alt-arrow-up-bold] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
            queueOpen && "rotate-180 translate-y-[1.5px]"
          )}
          label={queueOpen ? "Close queue" : "Show queue"}
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onToggleQueue}
          className={queueOpen ? "text-primary" : undefined}
        />
      </div>
    </div>
  );
};

const volumeIconClass = (volume: number) => {
  if (volume === 0) return "icon-[solar--volume-cross-linear]";
  if (volume <= 50) return "icon-[solar--volume-small-linear]";
  return "icon-[solar--volume-loud-linear]";
};

const VolumeControl = ({ volume, setVolume }: { volume: number; setVolume: (volume: number) => void }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef(volume);
  const draggingRef = useRef(false);
  const pointerInside = useRef(false);
  const fromPointer = useRef(false);
  const lastAudible = useRef(volume || 50);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const revealed = hovered || focused || dragging;

  volumeRef.current = volume;

  const commitVolume = (next: number) => {
    const clamped = Math.min(100, Math.max(0, Math.round(next)));
    if (clamped > 0) lastAudible.current = clamped;
    else if (volumeRef.current > 0) lastAudible.current = volumeRef.current;
    volumeRef.current = clamped;
    setVolume(clamped);
  };

  const commitVolumeRef = useRef(commitVolume);
  commitVolumeRef.current = commitVolume;

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      sliderRef.current?.focus({ preventScroll: true });
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const change = Math.max(-8, Math.min(8, -(event.deltaY * unit) / 16));
      if (change !== 0) commitVolumeRef.current(volumeRef.current + change);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const focusSlider = () => {
    const slider = sliderRef.current;
    if (slider && document.activeElement !== slider) slider.focus({ preventScroll: true });
  };

  const valueFromClientY = (clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.height === 0) return volumeRef.current;
    const ratio = (rect.bottom - clientY) / rect.height;
    return Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  };

  const toggleMute = () => {
    if (volumeRef.current === 0) setVolume(lastAudible.current || 50);
    else {
      lastAudible.current = volumeRef.current;
      setVolume(0);
    }
  };

  const endDrag = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (!pointerInside.current) setFocused(false);
    if (volumeRef.current > 0) lastAudible.current = volumeRef.current;
  };

  const applyDrag = (clientY: number) => {
    const next = valueFromClientY(clientY);
    volumeRef.current = next;
    setVolume(next);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    focusSlider();
    draggingRef.current = true;
    setDragging(true);
    if (volumeRef.current > 0) lastAudible.current = volumeRef.current;
    applyDrag(event.clientY);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    applyDrag(event.clientY);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      commitVolume(volumeRef.current - 5);
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      commitVolume(volumeRef.current + 5);
    } else if (event.key === "Home") {
      event.preventDefault();
      commitVolume(0);
    } else if (event.key === "End") {
      event.preventDefault();
      commitVolume(100);
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    fromPointer.current = false;
    setFocused(false);
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerDown={() => {
        fromPointer.current = true;
      }}
      onMouseEnter={() => {
        pointerInside.current = true;
        setHovered(true);
      }}
      onMouseLeave={() => {
        pointerInside.current = false;
        setHovered(false);
        if (!draggingRef.current) setFocused(false);
      }}
      onFocus={() => {
        if (!fromPointer.current) setFocused(true);
      }}
      onBlur={onBlur}
    >
      <IconButton
        iconClass={volumeIconClass(volume)}
        label={volume === 0 ? "Unmute" : "Mute"}
        size="md"
        tone={volume === 0 ? "active" : "ghost"}
        iconScale="secondary"
        onClick={toggleMute}
      />
      <div
        className={cn(
          "absolute bottom-full left-1/2 z-30 -translate-x-1/2",
          revealed ? "pb-2" : "pointer-events-none h-0 overflow-hidden"
        )}
      >
        <div
          className={cn(
            "origin-bottom transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
            revealed ? "scale-y-100 opacity-100" : "scale-y-0 opacity-0"
          )}
        >
          <div
            ref={sliderRef}
            role="slider"
            tabIndex={0}
            aria-label="Volume"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={volume}
            aria-orientation="vertical"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onKeyDown}
            className="flex h-26 w-7 cursor-pointer touch-none items-center justify-center rounded-full bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] outline-none"
          >
            <div ref={trackRef} className="pointer-events-none relative h-20 w-6">
              <div
                className={cn(
                  "absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-full bg-primary-light transition-[width] duration-300",
                  dragging ? "w-1.5" : "w-1"
                )}
              >
                <div className="absolute inset-x-0 bottom-0 rounded-full bg-accent" style={{ height: `${volume}%` }} />
              </div>
              <div
                className={cn(
                  "absolute left-1/2 rounded-full pointer-events-none bg-accent transition-[width,height] duration-300",
                  dragging ? "size-3.5" : "size-3"
                )}
                style={{ bottom: `${volume}%`, transform: "translate(-50%, 50%)" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const PlayerProgress = ({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (time: number) => void;
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragValue, setDragValue] = useState(0);

  const displayTime = isDragging ? dragValue : currentTime;
  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    setDragValue(value);
    setIsDragging(true);
    onSeek(value);
  };

  const handlePointerUp = () => {
    setIsDragging(false);
  };

  return (
    <div className="flex absolute right-0 left-0 -top-3 items-center h-6 group">
      <div className="relative w-full h-[2px] group-hover:h-1 transition-all duration-300 bg-primary-light rounded-full">
        <div className="absolute top-0 left-0 h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={1}
          value={displayTime}
          onChange={handleChange}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
          className="absolute top-1/2 w-full h-6 opacity-0 -translate-y-1/2 cursor-pointer"
        />
        <div
          className="absolute top-1/2 w-0 h-0 rounded-full -translate-y-1/2 pointer-events-none group-hover:w-3 group-hover:h-3 bg-accent"
          style={{ left: `${progress}%`, transform: `translateX(-50%)` }}
        />
      </div>
    </div>
  );
};
