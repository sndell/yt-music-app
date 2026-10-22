/** Settings â†’ Equalizer: ten band faders, a bass shelf, a treble shelf, preamp. */

import { useEffect, useRef } from "react";
import { Switch } from "@/components/ui/Switch";
import { EQUALIZER_BANDS, EQUALIZER_GAIN_LIMIT, useEqualizer } from "@/features/player/lib/equalizer";
import { cn } from "@/util/cn";
import { SettingsRow } from "./SettingsSection";

const LIMIT = EQUALIZER_GAIN_LIMIT;
/** Wheel travel per dB, so one notch is one step and a trackpad still adds up. */
const WHEEL_STEP = 100;

const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const gainLabel = (value: number) => (value > 0 ? `+${value}` : String(value));
const clampGain = (value: number) => Math.max(-LIMIT, Math.min(LIMIT, Math.round(value)));

/**
 * The control itself: a drawn rail with the real range input kept inside it for
 * the keyboard and the screen reader. Pointer and wheel are handled here so the
 * thumb sits exactly where the cursor is, a scroll over a fader moves the fader
 * instead of the page, and a double click puts that one control back to zero.
 */
const Track = ({
  aria,
  value,
  disabled,
  vertical = false,
  onChange,
}: {
  aria: string;
  value: number;
  disabled: boolean;
  vertical?: boolean;
  onChange: (value: number) => void;
}) => {
  const rail = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const change = useRef(onChange);
  const latest = useRef({ value, disabled });

  useEffect(() => {
    change.current = onChange;
    latest.current = { value, disabled };
  }, [onChange, value, disabled]);

  // One write path, so several wheel ticks or pointer moves inside one render
  // still compound instead of all reading the same stale value.
  const commit = (next: number) => {
    latest.current = { ...latest.current, value: next };
    change.current(next);
  };

  useEffect(() => {
    const node = rail.current;
    if (!node) return;
    let travel = 0;
    const onWheel = (event: WheelEvent) => {
      if (latest.current.disabled) return;
      // Non-passive on purpose: without this the page scrolls under the fader.
      event.preventDefault();
      travel += Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const steps = Math.trunc(travel / WHEEL_STEP);
      if (steps === 0) return;
      travel -= steps * WHEEL_STEP;
      // Scrolling up is a negative delta, and up means louder.
      commit(clampGain(latest.current.value - steps));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const fromPointer = (clientX: number, clientY: number) => {
    const node = rail.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const ratio = vertical ? 1 - (clientY - rect.top) / rect.height : (clientX - rect.left) / rect.width;
    commit(clampGain(-LIMIT + Math.max(0, Math.min(1, ratio)) * 2 * LIMIT));
  };

  const grab = (event: React.PointerEvent) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    input.current?.focus({ preventScroll: true });
    fromPointer(event.clientX, event.clientY);
    // Window listeners rather than pointer capture, so a drag that leaves the
    // track keeps steering it and a released pointer never sticks.
    const move = (moveEvent: PointerEvent) => fromPointer(moveEvent.clientX, moveEvent.clientY);
    const drop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", drop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", drop);
  };

  const ratio = (value + LIMIT) / (2 * LIMIT);
  const fill = vertical
    ? { bottom: `${Math.min(ratio, 0.5) * 100}%`, height: `${Math.abs(ratio - 0.5) * 100}%` }
    : { left: `${Math.min(ratio, 0.5) * 100}%`, width: `${Math.abs(ratio - 0.5) * 100}%` };
  const thumb = vertical ? { bottom: `${ratio * 100}%` } : { left: `${ratio * 100}%` };

  return (
    <div
      ref={rail}
      onPointerDown={grab}
      onDoubleClick={() => {
        if (!disabled) commit(0);
      }}
      className={cn(
        "group relative touch-none select-none",
        vertical ? "h-36 w-full" : "h-5 w-full",
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      )}
    >
      <input
        ref={input}
        type="range"
        min={-LIMIT}
        max={LIMIT}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={aria}
        aria-valuetext={`${gainLabel(value)} dB`}
        onChange={(event) => change.current(clampGain(Number(event.target.value)))}
        className="peer sr-only"
      />
      <div
        className={cn(
          "absolute rounded-full bg-white/10",
          vertical ? "left-1/2 top-0 h-full w-[2px] -translate-x-1/2" : "left-0 right-0 top-1/2 h-[2px] -translate-y-1/2"
        )}
      />
      <div
        className={cn(
          "absolute rounded-full",
          value > 0 ? "bg-accent" : "bg-white/40",
          vertical ? "left-1/2 w-[2px] -translate-x-1/2" : "top-1/2 h-[2px] -translate-y-1/2"
        )}
        style={fill}
      />
      <div
        className={cn(
          "pointer-events-none absolute h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-150 group-hover:scale-125 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent",
          vertical ? "left-1/2 -translate-x-1/2 translate-y-1/2" : "top-1/2 -translate-x-1/2 -translate-y-1/2"
        )}
        style={thumb}
      />
    </div>
  );
};

const RowSlider = ({
  label,
  hint,
  aria,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  aria: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) => (
  <div className="space-y-2">
    <div className="flex items-baseline justify-between gap-2 text-[11px] leading-4">
      <span className="text-primary-dark">
        {label}
        <span className="text-primary-dark/60"> {hint}</span>
      </span>
      <span className={cn("tabular-nums", value === 0 ? "text-primary-dark/50" : "text-white")}>{gainLabel(value)}</span>
    </div>
    <Track aria={aria} value={value} disabled={disabled} onChange={onChange} />
  </div>
);

export const EqualizerSection = () => {
  const [settings, update] = useEqualizer();
  const off = !settings.enabled;

  const setBand = (index: number, value: number) => {
    const bands = settings.bands.slice();
    bands[index] = value;
    update({ ...settings, bands });
  };

  return (
    // One child in the section's divide wrapper, so the section's own divider
    // falls below the whole block and no line lands between the row and its faders.
    <div>
      <SettingsRow
        title="Equalizer"
        description="Ten bands from 31 Hz to 16 kHz, plus a 150 Hz bass shelf and a 6 kHz treble shelf. It runs inside the player, so the sound changes without another audio device in the chain. Scroll over a fader to nudge it, double-click to put it back to zero."
        control={
          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => update({ ...settings, preamp: 0, bass: 0, treble: 0, bands: EQUALIZER_BANDS.map(() => 0) })}
              className="h-8 cursor-pointer px-1 text-sm text-primary-dark transition-colors hover:text-white"
            >
              Reset
            </button>
            <Switch checked={settings.enabled} onChange={(enabled) => update({ ...settings, enabled })} label="Equalizer" />
          </div>
        }
      />
      <div className={cn("px-0.5 pb-2", off && "pointer-events-none opacity-40")}>
        <div>
          <div className="grid grid-cols-10 gap-2 text-center text-[11px] leading-4 tabular-nums">
            {settings.bands.map((value, index) => (
              <span key={EQUALIZER_BANDS[index]} className={value === 0 ? "text-primary-dark/50" : "text-white"}>
                {gainLabel(value)}
              </span>
            ))}
          </div>
          {/* One line through every rail, so the row reads as one scale. */}
          <div className="relative mt-2 grid grid-cols-10 gap-2">
            <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-white/10" />
            {settings.bands.map((value, index) => (
              <Track
                key={EQUALIZER_BANDS[index]}
                aria={`${bandLabel(EQUALIZER_BANDS[index])} Hz band`}
                value={value}
                disabled={off}
                vertical
                onChange={(next) => setBand(index, next)}
              />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-10 gap-2 text-center text-[11px] leading-4 text-primary-dark">
            {EQUALIZER_BANDS.map((hz) => (
              <span key={hz}>{bandLabel(hz)}</span>
            ))}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-x-8">
          <RowSlider
            label="Bass"
            hint="150 Hz"
            aria="Bass shelf"
            value={settings.bass}
            disabled={off}
            onChange={(bass) => update({ ...settings, bass })}
          />
          <RowSlider
            label="Treble"
            hint="6 kHz"
            aria="Treble shelf"
            value={settings.treble}
            disabled={off}
            onChange={(treble) => update({ ...settings, treble })}
          />
          <RowSlider
            label="Preamp"
            hint="level"
            aria="Preamp"
            value={settings.preamp}
            disabled={off}
            onChange={(preamp) => update({ ...settings, preamp })}
          />
        </div>
      </div>
    </div>
  );
};
