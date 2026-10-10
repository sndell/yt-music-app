import { useState, useRef, useCallback, useEffect, type FocusEvent, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { usePlayer } from "../context/PlayerContext";
import ReactPlayer from "react-player";
import { PyBridge } from "@/lib/api";
import { cn } from "@/util/cn";
import type { LikeStatus, Track } from "@/lib/api/types";

const EMBED_BLOCKED_CODES = new Set([101, 150]);

type YoutubePlayerElement = HTMLElement & {
  error?: { code?: number } | null;
};

const RESTART_THRESHOLD_SECONDS = 3;

// Square curve so the middle of the slider is quieter than a linear 50%.
// Rounded to a percent so YouTube's integer getVolume() matches what we set.
// Exact 0 is muted instead: the iframe API loops on setVolume(0).
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
    showBlockedEmbed,
    playNext,
    playPrevious,
    hasNext,
    hasPrevious,
    shuffle,
    toggleShuffle,
    rateSong,
    ratingPending,
  } = usePlayer();
  const [embedHost, setEmbedHost] = useState<HTMLElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loop, setLoop] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const elapsedRef = useRef(0);
  const [volume, setVolume] = useState(50);
  const lastGainRef = useRef(sliderToGain(50));
  const lastSeekTime = useRef(0);
  const gain = sliderToGain(volume);

  useEffect(() => {
    if (gain > 0) lastGainRef.current = gain;
  }, [gain]);

  elapsedRef.current = elapsedTime;

  const handleError = useCallback(
    (event: SyntheticEvent<YoutubePlayerElement>) => {
      const code = event.currentTarget.error?.code;
      if (code != null && EMBED_BLOCKED_CODES.has(code) && currentSong?.videoId) {
        showBlockedEmbed(currentSong.videoId);
      }
    },
    [currentSong?.videoId, showBlockedEmbed]
  );

  const handleSeek = useCallback((time: number) => {
    const now = Date.now();
    if (now - lastSeekTime.current < 100) return; // throttle to 100ms
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

  const handleEnded = useCallback(() => {
    if (loop) {
      restart();
      setIsPlaying(true);
      void playerRef.current?.play();
      return;
    }
    void playNext().then((advanced) => {
      if (!advanced) setIsPlaying(false);
    });
  }, [loop, playNext, restart]);

  useEffect(() => {
    if (!currentSong) return;
    setDuration(Number(currentSong.durationSeconds));
    setElapsedTime(0);
    setIsPlaying(true);
    setEmbedHost(document.getElementById("queue-embed"));
  }, [currentSong?.videoId]);

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

  useEffect(() => {
    window.pythonEvent = (action: string) => {
      if (action === "play") setIsPlaying(true);
      else if (action === "pause") setIsPlaying(false);
      else if (action === "next") handleNext();
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
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
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
      {embedHost &&
        createPortal(
          <ReactPlayer
            key={currentSong.videoId}
            volume={gain === 0 ? lastGainRef.current : gain}
            muted={gain === 0}
            onPlay={() => setIsPlaying(true)}
            onPause={() => {
              const player = playerRef.current;
              const duration = player?.duration ?? 0;
              const time = player?.currentTime ?? 0;
              if (loop && duration > 0 && time >= duration - 0.25) return;
              setIsPlaying(false);
            }}
            ref={playerRef}
            style={{ height: "100%", width: "100%" }}
            src={`https://www.youtube.com/watch?v=${currentSong.videoId}`}
            playing={isPlaying}
            onTimeUpdate={(e) => setElapsedTime(e.currentTarget.currentTime)}
            onDurationChange={(e) => setDuration(e.currentTarget.duration)}
            onEnded={handleEnded}
            onError={handleError}
          />,
          embedHost
        )}
    </>
  );
};

const iconButtonClass = (active = false) =>
  cn(
    "grid size-10 cursor-pointer place-items-center rounded-full transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40",
    active
      ? "bg-[oklch(0.24_0_0)] text-primary hover:bg-[oklch(0.27_0_0)]"
      : "text-primary-dark hover:bg-primary-light hover:text-primary"
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
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] col-span-2 items-center">
      <div className="flex gap-1.5  items-center">
        <img src={currentSong.thumbnails[0].url} alt={currentSong.title} className="w-12 h-12 rounded-lg shrink-0" />
        <div className="flex flex-col">
          <span className="text-sm text-primary">{currentSong.title}</span>
          <span className="text-sm text-primary-dark">
            {currentSong.artists.map((artist) => artist.name).join(", ")}
          </span>
        </div>
        <div className="flex gap-1 items-center pl-3">
          <button
            type="button"
            aria-label="Like"
            aria-pressed={likeStatus === "LIKE"}
            disabled={ratingPending}
            onClick={() => onRate("LIKE")}
            className={cn(iconButtonClass(likeStatus === "LIKE"), "text-xl")}
          >
            <span className={likeStatus === "LIKE" ? "icon-[solar--like-bold]" : "icon-[solar--like-linear]"} />
          </button>
          <button
            type="button"
            aria-label="Dislike"
            aria-pressed={likeStatus === "DISLIKE"}
            disabled={ratingPending}
            onClick={() => onRate("DISLIKE")}
            className={cn(iconButtonClass(likeStatus === "DISLIKE"), "text-xl")}
          >
            <span className={likeStatus === "DISLIKE" ? "icon-[solar--dislike-bold]" : "icon-[solar--dislike-linear]"} />
          </button>
        </div>
      </div>
      <div className="flex gap-1 items-center text-xl ">
        <button
          type="button"
          aria-label="Previous"
          onClick={onPrevious}
          disabled={!canPrevious}
          className={iconButtonClass()}
        >
          <span className="icon-[solar--skip-previous-bold]" />
        </button>
        <button
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={isPlaying ? onPause : onPlay}
          className={cn(iconButtonClass(), "text-2xl")}
        >
          <span className={isPlaying ? "icon-[solar--pause-bold]" : "icon-[solar--play-bold]"} />
        </button>
        <button
          type="button"
          aria-label="Next"
          onClick={onNext}
          disabled={!canNext}
          className={iconButtonClass()}
        >
          <span className="icon-[solar--skip-next-bold]" />
        </button>
      </div>
      <div className="flex gap-1 items-center justify-self-end pr-3">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={onToggleShuffle}
          className={cn(iconButtonClass(shuffle), "text-2xl")}
        >
          <span className="icon-[solar--shuffle-linear]" />
        </button>
        <button
          type="button"
          aria-label="Loop"
          aria-pressed={loop}
          onClick={onToggleLoop}
          className={cn(iconButtonClass(loop), "text-2xl")}
        >
          <span
            className={
              loop ? "icon-[solar--repeat-one-minimalistic-linear]" : "icon-[solar--repeat-linear]"
            }
          />
        </button>
        <VolumeControl volume={volume} setVolume={setVolume} />
        <button
          type="button"
          onClick={onToggleQueue}
          aria-pressed={queueOpen}
          aria-label={queueOpen ? "Close queue" : "Show queue"}
          className={cn(iconButtonClass(queueOpen), "text-2xl")}
        >
          <span
            className={cn(
              "icon-[solar--alt-arrow-up-bold] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
              queueOpen && "rotate-180 translate-y-[1.5px]"
            )}
          />
        </button>
      </div>
    </div>
  );
};

const VolumeIcon = ({ volume }: { volume: number }) => {
  if (volume === 0) return <span className="icon-[solar--volume-cross-linear]" />;
  if (volume <= 50) return <span className="icon-[solar--volume-small-linear]" />;
  return <span className="icon-[solar--volume-loud-linear]" />;
};

const VolumeControl = ({ volume, setVolume }: { volume: number; setVolume: (volume: number) => void }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef(volume);
  const draggingRef = useRef(false);
  const pointerInside = useRef(false);
  const fromPointer = useRef(false);
  const lastAudible = useRef(volume || 50);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(true);
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
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      const change = Math.max(-8, Math.min(8, -(event.deltaY * unit) / 16));
      if (change !== 0) commitVolumeRef.current(volumeRef.current + change);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

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
      <button
        type="button"
        aria-label={volume === 0 ? "Unmute" : "Mute"}
        onClick={toggleMute}
        className={cn(iconButtonClass(volume === 0), "text-xl")}
      >
        <VolumeIcon volume={volume} />
      </button>
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
            className="flex h-26 w-7 cursor-pointer touch-none items-center justify-center rounded-full bg-black shadow-[0_10px_28px_rgb(0_0_0/0.65)] focus:outline-2 focus:outline-offset-2 focus:outline-white"
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
