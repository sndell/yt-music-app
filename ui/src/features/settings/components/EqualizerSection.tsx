/** The Settings section: ten band sliders, bass and treble shelves, preamp. */

import { EQUALIZER_BANDS, EQUALIZER_GAIN_LIMIT, useEqualizer } from "@/features/player/lib/equalizer";
import { cn } from "@/util/cn";
import { SettingsAction, SettingsRow } from "./SettingsSection";

const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const gainLabel = (value: number) => (value > 0 ? `+${value}` : String(value));

const Slider = ({
  label,
  hint,
  aria,
  value,
  disabled,
  vertical = false,
  onChange,
}: {
  label: string;
  hint?: string;
  aria: string;
  value: number;
  disabled: boolean;
  vertical?: boolean;
  onChange: (value: number) => void;
}) => (
  <label className={cn("flex cursor-pointer flex-col items-center gap-1.5", disabled && "cursor-not-allowed")}>
    <span className="flex items-center gap-1 text-[11px] tabular-nums text-primary-dark">
      {gainLabel(value)}
      {!vertical && <span className="text-primary-dark/70">dB</span>}
    </span>
    <input
      type="range"
      min={-EQUALIZER_GAIN_LIMIT}
      max={EQUALIZER_GAIN_LIMIT}
      step={1}
      value={value}
      disabled={disabled}
      aria-label={aria}
      onChange={(event) => onChange(Number(event.target.value))}
      className={cn(
        "cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-40",
        vertical ? "h-32 w-4 [direction:rtl] [writing-mode:vertical-lr]" : "w-full"
      )}
    />
    <span className="text-[11px] text-primary-dark">
      {label}
      {hint && <span className="text-primary-dark/60"> {hint}</span>}
    </span>
  </label>
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
    <>
      <SettingsRow
        title="Equalizer"
        description="Ten bands from 31 Hz to 16 kHz, plus a 150 Hz bass shelf and a 6 kHz treble shelf. It runs inside the player, so the sound changes without another audio device in the chain."
        control={
          <div className="flex items-center gap-3">
            <SettingsAction
              onClick={() => update({ ...settings, preamp: 0, bass: 0, treble: 0, bands: EQUALIZER_BANDS.map(() => 0) })}
            >
              Reset
            </SettingsAction>
            <Switch checked={settings.enabled} onChange={(enabled) => update({ ...settings, enabled })} label="Equalizer" />
          </div>
        }
      />
      <div className="px-0.5 pb-2">
        <div className="flex items-end justify-between gap-1">
          {EQUALIZER_BANDS.map((hz, index) => (
            <Slider
              key={hz}
              label={bandLabel(hz)}
              aria={`${bandLabel(hz)} Hz band`}
              value={settings.bands[index] ?? 0}
              disabled={off}
              vertical
              onChange={(value) => setBand(index, value)}
            />
          ))}
        </div>
        <div className="mt-1 grid grid-cols-3 gap-4 border-t border-white/5 pt-3">
          <Slider
            label="Bass"
            hint="150 Hz"
            aria="Bass shelf"
            value={settings.bass}
            disabled={off}
            onChange={(bass) => update({ ...settings, bass })}
          />
          <Slider
            label="Treble"
            hint="6 kHz"
            aria="Treble shelf"
            value={settings.treble}
            disabled={off}
            onChange={(treble) => update({ ...settings, treble })}
          />
          <Slider
            label="Preamp"
            hint="level"
            aria="Preamp"
            value={settings.preamp}
            disabled={off}
            onChange={(preamp) => update({ ...settings, preamp })}
          />
        </div>
      </div>
    </>
  );
};
