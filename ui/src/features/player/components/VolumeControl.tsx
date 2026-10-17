/** Split out of Player.tsx. */

import { useState, useRef, useEffect, type FocusEvent, type KeyboardEvent, type PointerEvent } from "react";
import { IconButton } from "@/components/ui/IconButton";
import { cn } from "@/util/cn";

const volumeIconClass = (volume: number) => {
  if (volume === 0) return "icon-[solar--volume-cross-linear]";
  if (volume <= 50) return "icon-[solar--volume-small-linear]";
  return "icon-[solar--volume-loud-linear]";
};

export const VolumeControl = ({ volume, setVolume }: { volume: number; setVolume: (volume: number) => void }) => {
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
