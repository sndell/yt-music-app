import { useState, useRef, useCallback, useEffect } from "react";
import { usePlayer } from "../context/PlayerContext";
import ReactPlayer from "react-player";
import { cn } from "@/util/cn";
import type { Track } from "@/lib/api/types";

export const Player = () => {
  const { currentSong } = usePlayer();
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [volume, setVolume] = useState(50);
  const lastSeekTime = useRef(0);

  const handleSeek = useCallback((time: number) => {
    const now = Date.now();
    if (now - lastSeekTime.current < 100) return; // throttle to 100ms
    lastSeekTime.current = now;

    if (playerRef.current) {
      playerRef.current.currentTime = time;
    }
  }, []);

  useEffect(() => {
    if (!currentSong) return;
    setDuration(Number(currentSong.durationSeconds));
    setElapsedTime(0);
    setIsPlaying(true);
  }, [currentSong]);

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
          isPlaying={isPlaying}
        />
      </div>
      <div className="absolute right-8 bottom-24 h-64 bg-red-500 aspect-video">
        <ReactPlayer
          volume={volume / 100}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          ref={playerRef}
          style={{ height: "100%", width: "100%" }}
          src={`https://www.youtube.com/watch?v=${currentSong.videoId}`}
          playing={isPlaying}
          onTimeUpdate={(e) => setElapsedTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        />
      </div>
    </>
  );
};

const PlayerControls = ({
  currentSong,
  volume,
  setVolume,
  onPlay,
  onPause,
  isPlaying,
}: {
  currentSong: Track;
  volume: number;
  setVolume: (volume: number) => void;
  onPlay: () => void;
  onPause: () => void;
  isPlaying: boolean;
}) => {
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
      </div>
      <div className="flex gap-1.5 items-center text-2xl ">
        <button className="icon-[mingcute--skip-previous-fill] text-primary-dark cursor-pointer" />
        <button
          onClick={isPlaying ? onPause : onPlay}
          className={cn(
            "text-3xl cursor-pointer icon-[mingcute--pause-fill] text-primary-dark",
            isPlaying ? "icon-[mingcute--pause-fill]" : "icon-[mingcute--play-fill]"
          )}
        />
        <button className="icon-[mingcute--skip-forward-fill] text-primary-dark cursor-pointer" />
      </div>
      <div className="justify-self-end pr-3">
        <VolumeControl volume={volume} setVolume={setVolume} />
      </div>
    </div>
  );
};

const VolumeControl = ({ volume, setVolume }: { volume: number; setVolume: (volume: number) => void }) => {
  const progress = volume;

  return (
    <div className="flex gap-3 items-center group">
      <span className="icon-[mingcute--volume-line] text-primary-dark text-lg" />
      <div className="relative w-20 h-1 rounded-full transition-all duration-300 bg-primary-light">
        <div className="absolute top-0 left-0 h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
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
