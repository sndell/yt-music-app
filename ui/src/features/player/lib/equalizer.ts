/**
 * The built-in equalizer: ten peaking bands plus bass and treble shelves,
 * running as a Web Audio graph over the player's <audio> element.
 *
 * The filters sit in Chromium's own render path, so the EQ costs no extra
 * decode, no second audio device and no added latency. Python only stores the
 * settings; the audio itself never leaves the page.
 */

import { useEffect, useState } from "react";
import { PyBridge } from "@/lib/api";
import type { EqualizerSettings } from "@/lib/api/types";

/** Band centres in Hz, low to high. The stored settings carry one gain each. */
export const EQUALIZER_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Slider travel, in dB, and the limit Python refuses to store past. */
export const EQUALIZER_GAIN_LIMIT = 12;

/** Octave-spaced bands cross at about -3 dB with this Q, like a graphic EQ. */
const BAND_Q = 1.41;
const BASS_HZ = 150;
const TREBLE_HZ = 6000;
/** Ride the param instead of jumping it, so a drag does not click. */
const RAMP_SECONDS = 0.02;
const SAVE_DELAY_MS = 400;

type Listener = (settings: EqualizerSettings) => void;

const empty = (): EqualizerSettings => ({
  enabled: false,
  preamp: 0,
  bass: 0,
  treble: 0,
  bands: EQUALIZER_BANDS.map(() => 0),
});

const listeners = new Set<Listener>();
let current: EqualizerSettings = empty();
let loadPromise: Promise<void> | null = null;
let saveTimer: number | undefined;

let context: AudioContext | null = null;
let element: HTMLAudioElement | null = null;
let wired = false;
let graph: {
  preamp: GainNode;
  bass: BiquadFilterNode;
  treble: BiquadFilterNode;
  bands: BiquadFilterNode[];
} | null = null;

const clampGain = (value: unknown): number => {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return Math.max(-EQUALIZER_GAIN_LIMIT, Math.min(EQUALIZER_GAIN_LIMIT, Math.round(number)));
};

/** Stored payload as the module holds it: every band present and in range. */
const normalize = (value: EqualizerSettings | null | undefined): EqualizerSettings => {
  if (!value || typeof value !== "object") return empty();
  const bands = Array.isArray(value.bands) ? value.bands : [];
  return {
    enabled: value.enabled === true,
    preamp: clampGain(value.preamp),
    bass: clampGain(value.bass),
    treble: clampGain(value.treble),
    bands: EQUALIZER_BANDS.map((_, index) => clampGain(bands[index])),
  };
};

const apply = () => {
  const ctx = context;
  const nodes = graph;
  if (!ctx || !nodes) return;
  const settings = current;
  const now = ctx.currentTime;
  const ramp = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, RAMP_SECONDS);
  // Off leaves every filter flat rather than unwiring the graph, which cannot
  // be undone on a media element and would click while it happened.
  const on = settings.enabled;
  ramp(nodes.preamp.gain, on ? Math.pow(10, settings.preamp / 20) : 1);
  ramp(nodes.bass.gain, on ? settings.bass : 0);
  ramp(nodes.treble.gain, on ? settings.treble : 0);
  nodes.bands.forEach((filter, index) => ramp(filter.gain, on ? settings.bands[index] ?? 0 : 0));
};

const publish = (next: EqualizerSettings) => {
  current = next;
  apply();
  for (const listener of listeners) listener(next);
};

type Graph = {
  context: AudioContext;
  preamp: GainNode;
  bass: BiquadFilterNode;
  treble: BiquadFilterNode;
  bands: BiquadFilterNode[];
};

/**
 * The element carries its own graph. Capturing a media element cannot be undone
 * or repeated, so a module replaced by a hot update has to adopt the graph the
 * old one built; capturing again throws and leaves the equalizer dead.
 */
const GRAPH_KEY = "__ytmusicEqualizer";

const build = () => {
  const source = element;
  if (context || !source) return;
  const adopted = (source as unknown as Record<string, Graph | undefined>)[GRAPH_KEY];
  if (adopted) {
    context = adopted.context;
    graph = { preamp: adopted.preamp, bass: adopted.bass, treble: adopted.treble, bands: adopted.bands };
    apply();
    return;
  }
  const ctx = new AudioContext({ latencyHint: "playback" });
  const filter = (type: BiquadFilterType, hz: number, q?: number) => {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = hz;
    if (q !== undefined) node.Q.value = q;
    return node;
  };
  const preamp = ctx.createGain();
  const bass = filter("lowshelf", BASS_HZ);
  const treble = filter("highshelf", TREBLE_HZ);
  const bands = EQUALIZER_BANDS.map((hz) => filter("peaking", hz, BAND_Q));

  let tail: AudioNode;
  try {
    tail = ctx.createMediaElementSource(source);
  } catch (error) {
    console.warn("Equalizer could not capture the audio element; playing unprocessed.", error);
    void ctx.close();
    return;
  }
  tail.connect(preamp);
  tail = preamp;
  for (const node of [bass, ...bands, treble]) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(ctx.destination);

  (source as unknown as Record<string, Graph>)[GRAPH_KEY] = { context: ctx, preamp, bass, treble, bands };
  context = ctx;
  graph = { preamp, bass, treble, bands };
  apply();
};

/**
 * Route one audio element through the equalizer. Call once per element: a
 * media element can only be captured once, and the capture lasts its life.
 *
 * The graph is built on the first `play`, which is a user gesture, so the
 * context comes up running instead of muting the app until something is
 * clicked.
 */
export const attachEqualizer = (audio: HTMLAudioElement) => {
  if (wired) return;
  wired = true;
  element = audio;
  const start = () => {
    build();
    if (context && context.state !== "running") void context.resume();
  };
  audio.addEventListener("play", start);
  // A context can be suspended by the OS after a device change; the next tap
  // anywhere brings it back.
  window.addEventListener("pointerdown", start, { capture: true });
};

/** Read the stored settings once. Safe to call from every mount. */
export const loadEqualizer = (): Promise<void> => {
  if (loadPromise) return loadPromise;
  loadPromise = PyBridge.getEqualizer().then((result) => {
    if (result.success) publish(normalize(result.data));
  });
  return loadPromise;
};

/** Show a change now and write it to disk once the slider settles. */
export const setEqualizer = (next: EqualizerSettings) => {
  publish(normalize(next));
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void PyBridge.setEqualizer(current);
  }, SAVE_DELAY_MS);
};

/** The settings, live, for the settings page. */
export const useEqualizer = () => {
  const [settings, setSettings] = useState<EqualizerSettings>(current);
  useEffect(() => {
    listeners.add(setSettings);
    void loadEqualizer();
    return () => {
      listeners.delete(setSettings);
    };
  }, []);
  return [settings, setEqualizer] as const;
};

