import { useState } from "react";
/** Split out of Player.tsx. */


export const PlayerProgress = ({
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
