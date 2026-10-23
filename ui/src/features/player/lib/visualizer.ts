/**
 * The audio visualizer: a fullscreen Three.js scene driven by the player's
 * own signal.
 *
 * The spectrum comes from an analyser tapped onto the equalizer's audio graph
 * (equalizer.ts owns the media-element capture), so what is drawn is the
 * sound that is actually heard, filters included. The scene itself is one
 * fullscreen fragment-shader pair: each frame, a composite pass draws this
 * frame's visual content on top of the previous one, which is read back from
 * a ping-pong render target — pushed outward, spun and warped every time.
 * That feedback is what gives the picture glowing trails, Butterchurn-style,
 * at the cost of two quads; a present pass then tonemaps, vignettes and
 * grains the composite onto the canvas.
 *
 * The analysis layer is what the classic visualizers did with per-frame
 * equations, rebuilt in TypeScript: alongside the smoothed bass/mid/treble a
 * spectral-flux onset detector fires discrete beats, the spectral centroid
 * steers the palette, an attenuated copy of each band drives motion (so the
 * picture relaxes with the music instead of pumping constantly), the raw
 * time-domain waveform feeds a ring drawn inside the bars, and each bar
 * carries a slowly falling peak cap.
 *
 * Colors are read from the app accent, which is authored as `oklch()` in
 * globals.css; the shader converts oklch to RGB itself and shades in that
 * space, so the visualizer follows the accent the settings page sets.
 */

import * as THREE from "three";
import { activeAudio } from "./activeAudio";
import { audioAnalyser } from "./equalizer";

const BAND_COUNT = 64;
const F_MIN = 32;
const F_MAX = 16000;
/** Time-domain samples handed to the shader for the waveform ring. */
const WAVE_SAMPLES = 256;
/** Frames of spectral-flux history the onset detector keeps. Flux is noisy; the adaptive threshold reads its own past. */
const FLUX_HISTORY = 48;
/** Frames of history for the per-register onset detectors (sub-bass, treble). */
const SPLIT_FLUX_HISTORY = 32;
/** Below: kick/sub territory, above: hats and air — the two unique visual feeds. */
const SUB_HZ = 180;
const TREBLE_HZ = 3500;
/** Refractory between onsets: kick and snare within this count as one. Keeps
 * shockwaves as events — at 0.13 s they fire 7×/s and read as ring noise. */
const BEAT_REFRACTORY = 0.3;
/** Pixie sparks ride the rim on treble onsets; this pool is their life. */
const PIXIE_COUNT = 24;

export type VisualizerFrame = {
  bass: number;
  mid: number;
  treble: number;
  level: number;
  beat: number;
  pulseAge: number;
  /** Dark quake ripple driven by the sub-band flux alone. */
  quake: number;
  quakeAge: number;
  /** Treble-spawned sparks, per slot: (x, y) in screen units, life, hue offset. */
  pixies: THREE.Vector4[];
  /** Per-event epicenters in disc units — rings don't all fire from the middle. */
  shockPos: THREE.Vector2;
  quakePos: THREE.Vector2;
  soundCenter: number;
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  spectrum: Float32Array<ArrayBuffer>;
  /** Per-band falling peaks, for the caps riding the bar tips. */
  peaks: Float32Array<ArrayBuffer>;
  /** The raw waveform, -1..1 over WAVE_SAMPLES. */
  wave: Float32Array<ArrayBuffer>;
};

export type VisualizerEngine = {
  render: (frame: VisualizerFrame, timeSeconds: number, dt: number) => void;
  resize: () => void;
  dispose: () => void;
};

/** Defaults to the current accent in globals.css; any parse failure lands here too. */
const FALLBACK_ACCENT: [number, number, number] = [0.55, 0.21, 27.19];

/** The oklch channels of `--color-accent`, for the shader to shade with. */
export const readAccent = (): [number, number, number] => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--color-accent");
  const match = raw.match(/oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)/);
  if (!match) return FALLBACK_ACCENT;
  const channel = (text: string, of: number) => {
    const value = parseFloat(text);
    return text.endsWith("%") ? (value / 100) * of : value;
  };
  return [channel(match[1], 1), channel(match[2], 0.4), match[3] === undefined ? FALLBACK_ACCENT[2] : parseFloat(match[3])];
};

/**
 * Demo mode feeds a synthetic song to the scene, so the visualizer can be
 * tuned and checked without playing anything. Dev surface only, riding on the
 * page under `window.__vizDemo(true | false)`.
 */
let demoMode = false;
export const setDemoMode = (on: boolean) => {
  demoMode = on;
};
declare global {
  interface Window {
    __vizDemo?: (on: boolean) => void;
  }
}
if (import.meta.env.DEV) {
  window.__vizDemo = setDemoMode;
}
declare global {
  interface Window {
    __vizUniforms?: { spectrum: { value: Float32Array } } & Record<string, { value: unknown }>;
  }
}

export type AnalysisState = {
  bands: Float32Array<ArrayBuffer>;
  bins: Uint8Array<ArrayBuffer> | null;
  /** Copy of the previous frame's bins, for the flux difference. */
  prevBins: Uint8Array<ArrayBuffer> | null;
  fluxHistory: Float32Array<ArrayBuffer>;
  fluxIdx: number;
  fluxFilled: number;
  /** Sub-band and treble flux histories, the two unique-visual feeds. */
  subHistory: Float32Array<ArrayBuffer>;
  subIdx: number;
  subFilled: number;
  trebHistory: Float32Array<ArrayBuffer>;
  trebIdx: number;
  trebFilled: number;
  /** Sub-quake and the pixie spark pool with its cooldown. Each event also
   * draws from a random epicenter, so effects don't stack on one center. */
  quake: number;
  quakePulseAge: number;
  quakePos: THREE.Vector2;
  shockPos: THREE.Vector2;
  pixieCooldown: number;
  pixies: THREE.Vector4[];
  timeDomain: Uint8Array<ArrayBuffer> | null;
  wave: Float32Array<ArrayBuffer>;
  peaks: Float32Array<ArrayBuffer>;
  beat: number;
  pulseAge: number;
  /** Spectral centroid, 0 (dark) to 1 (very bright); steers the palette. `centroid` itself is a reserved GLSL word. */
  soundCenter: number;
  /** Attenuated copies of bass/mid/treble — heavily damped in time, what MilkDrop calls bass_att. */
  bassAtt: number;
  midAtt: number;
  trebAtt: number;
  /** Per-band rolling average: the reference each band is shown relative to, the AGC that keeps loud masters pinned. */
  bandAtt: Float32Array<ArrayBuffer>;
  /** Mirror of the waveform AGC gain: quiet songs lift, loud songs don't clip the ribbon. */
  waveGain: number;
  bass: number;
  mid: number;
  treble: number;
  level: number;
};

export const createAnalysisState = (): AnalysisState => ({
  bands: new Float32Array(BAND_COUNT),
  bins: null,
  prevBins: null,
  fluxHistory: new Float32Array(FLUX_HISTORY),
  fluxIdx: 0,
  fluxFilled: 0,
  subHistory: new Float32Array(SPLIT_FLUX_HISTORY),
  subIdx: 0,
  subFilled: 0,
  trebHistory: new Float32Array(SPLIT_FLUX_HISTORY),
  trebIdx: 0,
  trebFilled: 0,
  quake: 0,
  quakePulseAge: 1e3,
  quakePos: new THREE.Vector2(),
  shockPos: new THREE.Vector2(),
  pixieCooldown: 0,
  pixies: Array.from({ length: PIXIE_COUNT }, () => new THREE.Vector4(0, 0, 0, 0)),
  timeDomain: null,
  wave: new Float32Array(WAVE_SAMPLES),
  bandAtt: new Float32Array(BAND_COUNT),
  waveGain: 1,
  peaks: new Float32Array(BAND_COUNT),
  beat: 0,
  pulseAge: 1e3,
  soundCenter: 0.35,
  bassAtt: 0,
  midAtt: 0,
  trebAtt: 0,
  bass: 0,
  mid: 0,
  treble: 0,
  level: 0,
});

/** Frequency edges of the log-spaced bands, precomputed once. */
const bandFrequencies = Array.from({ length: BAND_COUNT + 1 }, (_, i) => F_MIN * Math.pow(F_MAX / F_MIN, i / BAND_COUNT));

const readAnalyser = (state: AnalysisState, analyser: AnalyserNode, dt: number) => {
  const binCount = analyser.frequencyBinCount;
  const bins = state.bins && state.bins.length === binCount ? state.bins : (state.bins = new Uint8Array(binCount));
  const prevBins =
    state.prevBins && state.prevBins.length === binCount ? state.prevBins : (state.prevBins = new Uint8Array(binCount));
  analyser.getByteFrequencyData(bins);
  const binHz = analyser.context.sampleRate / 2 / binCount;

  // Spectral flux: how much energy arrived this frame that was not there
  // before. A kick, a snare or a chord change each show up as a jump, which a
  // smoothed band value never isolates. The same differences split by register
  // feed the two unique-visual detectors: the sub-bass quake and the treble
  // pixies, so those react to their own music, not the mix's loudness.
  let flux = 0;
  let subFlux = 0;
  let trebFlux = 0;
  let subBins = 0;
  let trebBins = 0;
  for (let j = 0; j < binCount; j++) {
    const v = bins[j];
    const diff = v - prevBins[j];
    if (diff > 0) flux += diff;
    const hz = j * binHz;
    if (hz < SUB_HZ) {
      if (diff > 0) subFlux += diff;
      subBins++;
    } else if (hz > TREBLE_HZ) {
      if (diff > 0) trebFlux += diff;
      trebBins++;
    }
    prevBins[j] = v;
  }
  flux /= binCount * 0.1;
  // The split ranges hold only a slice of the bins, so they normalize to their
  // own count and sit on bigger means — the same /0.1 scaling.
  subFlux = subFlux / Math.max(1, subBins) * 10;
  trebFlux = trebFlux / Math.max(1, trebBins) * 10;
  state.fluxHistory[state.fluxIdx] = flux;
  state.fluxIdx = (state.fluxIdx + 1) % FLUX_HISTORY;
  state.fluxFilled = Math.min(state.fluxFilled + 1, FLUX_HISTORY);
  state.subHistory[state.subIdx] = subFlux;
  state.subIdx = (state.subIdx + 1) % SPLIT_FLUX_HISTORY;
  state.subFilled = Math.min(state.subFilled + 1, SPLIT_FLUX_HISTORY);
  state.trebHistory[state.trebIdx] = trebFlux;
  state.trebIdx = (state.trebIdx + 1) % SPLIT_FLUX_HISTORY;
  state.trebFilled = Math.min(state.trebFilled + 1, SPLIT_FLUX_HISTORY);
  if (state.fluxFilled > 6) {
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < state.fluxFilled; j++) {
      const f = state.fluxHistory[j];
      sum += f;
      sumSq += f * f;
    }
    const mean = sum / state.fluxFilled;
    const std = Math.sqrt(Math.max(0, sumSq / state.fluxFilled - mean * mean));
    // The threshold sits on the song's own noise, and the strength is the
    // margin: a soft lyric onset reads gently, a drop reads like a drop.
    const margin = flux - (mean + 1.3 * std);
    if (margin > 0 && flux > 0.004 && state.pulseAge > BEAT_REFRACTORY) {
      const strength = Math.min(1, margin / (mean * 1.6 + 0.02));
      if (strength >= 0.22) {
        state.beat = Math.max(state.beat, strength);
        state.pulseAge = 0;
        // Every shockwave picks its own epicenter in disc space, so ripples
        // don't always burst from the middle.
        state.shockPos.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5);
      }
    }
  }
  // The sub-band detector alone drives the quake: a weight that belongs to
  // the kick drum, not to the mix. Lower threshold — the sub flux is sparse.
  if (state.subFilled > 8) {
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < state.subFilled; j++) {
      const f = state.subHistory[j];
      sum += f;
      sumSq += f * f;
    }
    const mean = sum / state.subFilled;
    const std = Math.sqrt(Math.max(0, sumSq / state.subFilled - mean * mean));
    const margin = subFlux - (mean + 1.15 * std);
    if (margin > 0 && subFlux > 0.02 && state.quakePulseAge > 0.35) {
      const strength = Math.min(1, margin / (mean * 1.5 + 0.08));
      if (strength >= 0.3) {
        state.quake = Math.max(state.quake, strength);
        state.quakePulseAge = 0;
        // The quake rolls out from where the low end lands, not always the core.
        state.quakePos.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.5);
      }
    }
  }
  // The treble detector spawns the pixies: hats and cymbals pop sparks at the
  // rim that ride outward and die. Cooled, or a crash cymbal floods the pool.
  state.pixieCooldown -= dt;
  if (state.pixieCooldown <= 0 && state.trebFilled > 8) {
    let sum = 0;
    let sumSq = 0;
    for (let j = 0; j < state.trebFilled; j++) {
      const f = state.trebHistory[j];
      sum += f;
      sumSq += f * f;
    }
    const mean = sum / state.trebFilled;
    const std = Math.sqrt(Math.max(0, sumSq / state.trebFilled - mean * mean));
    const margin = trebFlux - (mean + 1.2 * std);
    if (margin > 0 && trebFlux > 0.03) {
      const count = Math.min(3, 1 + Math.floor(margin / (mean + 0.02)));
      for (let n = 0; n < count; n++) {
        const pixie = state.pixies.find((p) => p.z <= 0);
        if (!pixie) break;
        // Spawn anywhere on the scene — random bearing, radius inside the
        // bars' root — so sparks don't crowd the rim ring.
        const bearing = Math.random() * Math.PI * 2;
        const radius = (0.12 + Math.random() * 0.55) / 2;
        pixie.set(Math.cos(bearing) * radius, Math.sin(bearing) * radius, 1, Math.random() * 80 - 40);
      }
      state.pixieCooldown = 0.14;
    }
  }

  for (let i = 0; i < BAND_COUNT; i++) {
    const lo = Math.max(1, Math.floor(bandFrequencies[i] / binHz));
    const hi = Math.min(binCount - 1, Math.max(lo, Math.ceil(bandFrequencies[i + 1] / binHz)));
    let peak = 0;
    for (let j = lo; j <= hi; j++) {
      if (bins[j] > peak) peak = bins[j];
    }
    // Every register shares the same byte range, so treble needs a tilt to
    // be seen at all beside the bass.
    const raw = Math.min(1, (peak / 255) * (1 + (i / BAND_COUNT) * 2.4));
    // The auto gain: each band rides a rolling average of itself, so a loud
    // master cannot pin the bars and a quiet passage still fills. A steady
    // recent level normalizes near 0.5; a transient reads above it.
    state.bandAtt[i] += (raw - state.bandAtt[i]) * Math.min(1, dt * 0.9);
    const value = Math.min(1, raw / Math.max(0.16, state.bandAtt[i] * 1.8 + 0.12));
    const held = state.bands[i];
    // Fast attack, eased release: hits jump, tails melt.
    state.bands[i] = value > held ? value : held * Math.exp(-dt * 5.5);
  }

  // The raw waveform for the ring. Sampled, not averaged: aliasing does not
  // matter for something drawn as a glowing line.
  analyser.getByteTimeDomainData(state.timeDomain || (state.timeDomain = new Uint8Array(analyser.fftSize)));
  const td = state.timeDomain!;
  const tdLength = td.length;
  let magnitude = 0.002;
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    const sample = Math.abs(td[(i * tdLength / WAVE_SAMPLES) | 0] / 128 - 1);
    if (sample > magnitude) magnitude = sample;
  }
  // The waveform gets the same treatment as the bands: gain hugs its recent
  // peak so a quiet ballad still draws a ribbon and a crushed master stays a
  // ribbon, not a square. Catches down fast, lifts back slowly.
  const targetGain = Math.min(2.6, 0.8 / Math.max(0.14, magnitude));
  state.waveGain = targetGain < state.waveGain
    ? targetGain
    : state.waveGain + (targetGain - state.waveGain) * Math.min(1, dt * 1.5);
  const wave = state.wave;
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    wave[i] = Math.max(-1, Math.min(1, (td[(i * tdLength / WAVE_SAMPLES) | 0] / 128 - 1) * state.waveGain));
  }
};

/** Nothing has played yet, or the element was never captured: a quiet breathing ring. */
const idleBands = (state: AnalysisState, timeSeconds: number) => {
  for (let i = 0; i < BAND_COUNT; i++) {
    state.bands[i] = 0.045 + 0.04 * (0.5 + 0.5 * Math.sin(timeSeconds * 0.9 + i * 0.31));
  }
  const wave = state.wave;
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    const t = i / WAVE_SAMPLES;
    wave[i] = 0.18 * (Math.sin(t * 6.28318530718 * 3 + timeSeconds * 1.7) + 0.5 * Math.sin(t * 6.28318530718 * 9 - timeSeconds * 2.3));
  }
};

const demoBands = (state: AnalysisState, timeSeconds: number, dt: number) => {
  const kick = Math.exp(-((timeSeconds * 2.05) % 1) * 7);
  const snare = Math.exp(-((timeSeconds * 2.05 + 0.5) % 1) * 9) * 0.35;
  const hats = Math.exp(-((timeSeconds * 8.2) % 1) * 30) * 0.5;
  for (let i = 0; i < BAND_COUNT; i++) {
    const f = i / BAND_COUNT;
    // A rolling floor weighted to low registers, a hill that sweeps the
    // midrange, and kick, snare and hats on top.
    const slope = Math.pow(1 - f, 1.6);
    const wave = 0.3 * slope * (0.65 + 0.35 * Math.sin(timeSeconds * 1.8 - f * 9.0));
    const hillCentre = 0.15 + 0.65 * (0.5 + 0.5 * Math.sin(timeSeconds * 0.23));
    const hill = 0.32 * Math.exp(-Math.pow((f - hillCentre) * 6, 2));
    let value = wave + hill;
    if (f < 0.14) value += kick * (1 - f / 0.14) * 0.9;
    value += snare * Math.exp(-Math.abs(f - 0.08) * 40);
    if (f > 0.6) value += hats * Math.random() * 0.8;
    state.bands[i] = Math.min(1, value + 0.05);
  }
  // A synthetic ring that breathes with the demo kick, and the demo tempo's
  // own onsets so the shockwaves fire like they will on a real song: pulse
  // age reset straight to the kick phase each frame.
  const wave = state.wave;
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    const t = i / WAVE_SAMPLES;
    wave[i] = (0.55 * Math.sin(t * 6.28318530718 * 4 + timeSeconds * 3.1) + 0.25 * Math.sin(t * 6.28318530718 * 13 - timeSeconds * 5.7)) *
      (0.4 + 0.6 * kick);
  }
  const period = 1 / 2.05;
  state.pulseAge = Math.max(0, (timeSeconds % period) - dt);
  state.beat = Math.exp(-state.pulseAge * 9);
};

/**
 * Bass, mid and treble follow the bands they summarise, fast to rise, slow to
 * fall; the peaks fall behind them; the centroid eases toward its target.
 */
const fold = (state: AnalysisState, dt: number) => {
  let bass = 0;
  let mid = 0;
  let treble = 0;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    const value = state.bands[i];
    if (i < 8) bass += value / 8;
    else if (i < 32) mid += value / 24;
    else treble += value / (BAND_COUNT - 32);
    total += value;
    weighted += value * i;
    // Falling peak caps: hold the max, sink slowly. The fall quickens the
    // higher the peak sits, so tall bars shed their caps first.
    const fall = state.peaks[i] - dt * (0.18 + 0.35 * state.peaks[i]);
    state.peaks[i] = Math.max(state.bands[i], fall);
  }
  const follow = (held: number, target: number) =>
    target > held ? held + (target - held) * 0.5 : held * Math.exp(-dt * 4);
  state.bass = follow(state.bass, bass);
  state.mid = follow(state.mid, mid);
  state.treble = follow(state.treble, treble);
  state.level = state.bass * 0.4 + state.mid * 0.35 + state.treble * 0.25;
  // The attenuated copies ease to their targets much slower (τ ≈ 0.8 s),
  // which is what the motion code reads: relaxed, not pumping.
  const ease = Math.min(1, dt * 1.2);
  state.bassAtt += (state.bass - state.bassAtt) * ease;
  state.midAtt += (state.mid - state.midAtt) * ease;
  state.trebAtt += (state.treble - state.trebAtt) * ease;
  // The centroid lives in band space; total>0 keeps silence from NaN.
  if (total > 0.001) {
    const target = weighted / total / BAND_COUNT;
    state.soundCenter += (target - state.soundCenter) * Math.min(1, dt * 2.5);
  }
  state.beat *= Math.exp(-dt * 7);
  state.pulseAge += dt;
  // The sub-quake relaxes slower than the beat: weight, not punch.
  state.quake *= Math.exp(-dt * 3.2);
  state.quakePulseAge += dt;
  // Pixies ride outward from wherever they popped and burn out.
  for (const pixie of state.pixies) {
    if (pixie.z <= 0) continue;
    pixie.x *= 1 + dt * 0.3;
    pixie.y *= 1 + dt * 0.3;
    pixie.z -= dt * 0.75;
    if (pixie.z < 0) pixie.z = 0;
  }
};

/** One frame of display data. Reads whatever is playing right now. */
export const readVisualizerFrame = (state: AnalysisState, timeSeconds: number, dt: number): VisualizerFrame => {
  const analyser = demoMode ? null : audioAnalyser(activeAudio());
  if (analyser) readAnalyser(state, analyser, dt);
  else if (demoMode) demoBands(state, timeSeconds, dt);
  else idleBands(state, timeSeconds);
  fold(state, dt);
  return {
    bass: state.bass,
    mid: state.mid,
    treble: state.treble,
    level: state.level,
    beat: state.beat,
    pulseAge: state.pulseAge,
    quake: state.quake,
    quakeAge: state.quakePulseAge,
    pixies: state.pixies,
    shockPos: state.shockPos,
    quakePos: state.quakePos,
    soundCenter: state.soundCenter,
    bassAtt: state.bassAtt,
    midAtt: state.midAtt,
    trebAtt: state.trebAtt,
    spectrum: state.bands,
    peaks: state.peaks,
    wave: state.wave,
  };
};

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** oklch → sRGB, shared by every shader that shades in the accent space. */
const OKLCH_GLSL = /* glsl */ `
  vec3 oklchToRgb(float lightness, float chroma, float hueDeg) {
    float h = radians(hueDeg);
    float hr = cos(h) * chroma;
    float hg = sin(h) * chroma;
    float l_ = lightness + 0.3963377774 * hr + 0.2158037573 * hg;
    float m_ = lightness - 0.1055613458 * hr - 0.0638541728 * hg;
    float s_ = lightness - 0.0894841775 * hr - 1.2914855480 * hg;
    l_ = l_ * l_ * l_;
    m_ = m_ * m_ * m_;
    s_ = s_ * s_ * s_;
    return clamp(vec3(
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
    ), 0.0, 1.0);
  }
`;

const COMPOSITE_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform sampler2D prev;
  uniform sampler2D stage;
  uniform vec2 res;
  uniform float time;
  uniform float dt;
  uniform vec3 accent;
  uniform float bass;
  uniform float mid;
  uniform float treble;
  uniform float level;
  uniform float beat;
  uniform float pulseAge;
  /** The sub-band quake: a dark ripple the low end owns, from its own epicenter. */
  uniform float quake;
  uniform float quakeAge;
  uniform vec2 quakePos;
  uniform vec2 shockPos;
  /** Treble-spawned sparks: (x, y) scene position, life, hue offset. */
  uniform vec4 pixies[${PIXIE_COUNT}];
  uniform float soundCenter;
  uniform float bassAtt;
  uniform float midAtt;
  uniform float trebAtt;
  uniform float pWarp;
  uniform float pSpin;
  uniform float pFan;
  uniform float pReach;
  uniform float pDust;
  uniform float pSway;
  uniform float pWaveAmp;
  uniform float pShock;
  uniform float pTravel;
  uniform float pStage;
  uniform float spectrum[${BAND_COUNT}];
  uniform float peaks[${BAND_COUNT}];
  uniform float wave[${WAVE_SAMPLES}];

  const float TAU = 6.28318530718;

  ${OKLCH_GLSL}

  float hash(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float sum = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 4; i++) {
      sum += amp * vnoise(p);
      p = p * 2.07 + vec2(13.7, 7.31);
      amp *= 0.5;
    }
    return sum;
  }

  // The band array, smoothed between neighbours, x in 0..1.
  float bandAt(float x) {
    float k = clamp(x, 0.0, 1.0) * 63.0;
    float j = floor(k);
    float f = k - j;
    return mix(spectrum[int(j)], spectrum[int(min(j + 1.0, 63.0))], f);
  }

  void main() {
    float aspect = res.x / max(res.y, 1.0);
    vec2 p = vUv - 0.5;
    vec2 sp = p * vec2(aspect, 1.0);
    float r = length(sp) * 2.0;
    float ang01 = fract(atan(sp.y, sp.x) / TAU + 0.75);

    // Per-frame motion, the MilkDrop chain: the attenuated bass relaxes the
    // pull, a fresh beat surges it, the mids spin, and a noise field warps
    // the drift so the trails curl instead of streaming straight.
    vec2 trail = p;
    trail *= 1.0 - (0.0032 + 0.016 * bassAtt + 0.020 * beat);
    float spin = dt * ((0.03 + 0.30 * midAtt + 0.55 * beat) * pSpin);
    trail = vec2(
      cos(spin) * trail.x - sin(spin) * trail.y,
      sin(spin) * trail.x + cos(spin) * trail.y
    );
    vec2 wp = trail * (3.5 + 0.8 * sin(time * 0.071));
    vec2 woff = vec2(fbm(wp + time * 0.11), fbm(wp.yx - time * 0.09)) - 0.5;
    trail += woff * ((0.006 + 0.030 * bassAtt) * pWarp);
    vec3 col = texture2D(prev, trail + 0.5, 0.0).rgb;
    // Adaptive anti-bloom: bright pixels release quickly so a loud passage
    // cannot accumulate to white, while dark ones keep their long haze tails.
    // The lower bound sits on ambient haze, not just near-white: disc-wide
    // fields accumulate against the slow decay otherwise.
    float lum = max(max(col.r, col.g), col.b);
    // The subtraction is a real floor: dark haze dies instead of ghosting forever.
    col = max(col * mix(0.84, 0.58, smoothstep(0.06, 0.45, lum)) - 0.004, 0.0);

    // The palette wanders with the spectral centroid: bright passages move
    // the whole scene one way, dark ones the other, so the color never sits.
    float hueTravel = time * 2.5 * pTravel + soundCenter * 70.0;

    // Radial spectrum bars, mirrored around the top, log-spaced.
    float mirrored = ang01 < 0.5 ? ang01 * 2.0 : (1.0 - ang01) * 2.0;
    const float HALF_CELLS = 72.0;
    float cell = mirrored * HALF_CELLS;
    float value = bandAt(cell / HALF_CELLS);
    float barMask = smoothstep(0.75, 0.4, abs(fract(cell) - 0.5) * 2.0);
    // The whole ring breathes with loudness, and the tips reach with it.
    float inner = 0.36 - 0.02 * level;
    float tip = inner + (0.02 + 0.45 * pReach * value * (0.45 + 0.85 * level));
    float bar =
      barMask *
      smoothstep(tip + 0.01, tip - 0.007, r) *
      smoothstep(inner - 0.02, inner + 0.015, r);
    // Hue climbs the accent palette from bass to treble, with a slow drift and
    // a kick of warmth on the beat.
    float hue = accent.z + hueTravel * 0.6 + mirrored * pFan * (0.4 + 0.6 * level) + bass * 8.0;
    vec3 barColor = oklchToRgb(0.62 + value * 0.14, 0.2, hue);
    // Emissions are sized for the feedback's steady state (per-frame gain is
    // 1 / (1 - decay)): a full-scale bar should land at a bright-not-clipped ring.
    col += bar * barColor * (0.04 + 0.10 * value);
    // Falling peak caps ride the same radius formula as the tips, so a cap
    // marks where the bar peaked before the music dropped out under it.
    int pk = int(min(63.0, floor(cell / HALF_CELLS * 63.0)));
    float capR = inner + (0.02 + 0.45 * pReach * peaks[pk] * (0.45 + 0.85 * level));
    float cap = barMask * smoothstep(0.007, 0.001, abs(r - capR));
    col += cap * oklchToRgb(0.82, 0.12, hue + 12.0) * 0.10;
    // The base keeps a whisper of light so the ring is present in silence.
    col += barMask * smoothstep(inner + 0.004, inner - 0.012, r) * smoothstep(inner - 0.05, inner, r) * barColor * 0.012;

    // The waveform ring, just inside the bars: the music's own shape, drawn
    // as a glowing line that swells with loudness.
    float w = wave[int(mirrored * float(${WAVE_SAMPLES - 1}))];
    float waveR = inner - 0.055 + 0.032 * pWaveAmp * w * (0.35 + 0.65 * level);
    float lineW = 0.006 + 0.010 * level;
    float d = abs(r - waveR);
    float waveLine = barMask * exp(-d * d / (2.0 * lineW * lineW));
    col += waveLine * oklchToRgb(0.68 + 0.12 * level, 0.17, accent.z - 90.0 + mirrored * 55.0 + hueTravel) * (0.035 + 0.075 * level);

    // Shockwave: every onset lights an expanding annulus from its own random
    // epicenter, modulated by noise so it reads as a ripple through the
    // haze, not a perfect circle — and never the same circle twice.
    vec2 shockOff = sp * 2.0 - shockPos;
    float shockDist = length(shockOff);
    float shockAng = fract(atan(shockOff.y, shockOff.x) / TAU + 0.75);
    float ringR = 0.34 + pulseAge * (0.55 + 0.45 * level);
    float ringA = exp(-pulseAge * 2.4);
    float ring = smoothstep(0.028, 0.0, abs(shockDist - ringR)) * ringA;
    ring *= 0.55 + 0.45 * fbm(vec2(shockAng * 7.0, ringR * 2.0 - time * 0.35));
    col += ring * oklchToRgb(0.62 + 0.2 * ringA, 0.16, accent.z + 30.0 * sin(time * 0.07) + hueTravel * 0.5) * pShock * (0.04 + 0.10 * level);

    // A halo where the bars take root.
    float halo = exp(-42.0 * abs(r - inner)) * (0.015 + 0.06 * level);
    col += halo * oklchToRgb(0.72, 0.15, accent.z - 10.0 + hueTravel) * 0.25;

    // The core, kicking with the bass.
    float core = exp(-12.0 * r * r);
    col += core * oklchToRgb(0.65, 0.11, accent.z + 6.0 + hueTravel) * (0.015 + 0.055 * bass);

    // A slowly drifting noise field that catches light with loudness.
    vec2 auroraUv = vec2(ang01 * 4.5, r * 1.4 - time * 0.1 * pSway);
    float dust = fbm(auroraUv * 2.2 + fbm(auroraUv - time * 0.06 * pSway) * 1.6);
    dust *= dust;
    col += dust * smoothstep(1.25, 0.3, r) *
      oklchToRgb(0.45, 0.13, accent.z + 150.0 + hueTravel) * (0.007 + 0.04 * level) * pDust;

    // A star field that twinkles harder on treble.
    vec2 grid = sp * 14.0;
    vec2 starCell = floor(grid);
    vec2 starP = fract(grid) - 0.5;
    float seed = hash(starCell);
    float twinkle = 0.35 + 0.65 * sin(time * (2.0 + 5.0 * hash(starCell + 7.3)) + seed * 40.0);
    col += smoothstep(0.94, 1.0, seed) * exp(-150.0 * dot(starP, starP)) * max(twinkle, 0.0) *
      (0.015 + 0.07 * treble) * oklchToRgb(0.88, 0.09, accent.z + hueTravel * 0.4);

    // The kick breathes over everything the frame produced.
    col *= 1.0 + 0.12 * exp(-pulseAge * 9.0);

    // The 3D stage floats over the energy field, lit by the same feedback:
    // its light trails, blooms and anti-blooms through the same pipeline as
    // everything the 2D world drawn.
    col += texture2D(stage, vUv).rgb * pStage;

    // The sub-bass quake. Where every other effect here adds light, this
    // one eats it: a black ripple rolling outward from the core, so the low
    // end has a texture that belongs to it alone and nothing sits on top of
    // the towers to blur them.
    float quakeR = 0.4 + quakeAge * 0.62;
    float quakeRing = exp(-pow((length(sp * 2.0 - quakePos) - quakeR) * 15.0, 2.0)) * quake;
    col *= 1.0 - 0.5 * quakeRing;

    // The treble pixies: sparks spawned by the high-register detector alone,
    // popping wherever they like on the scene, riding outward and burning
    // out mid flight. Nothing dark, nothing slow — the hats' own signature.
    for (int i = 0; i < ${PIXIE_COUNT}; i++) {
      vec4 pix = pixies[i];
      if (pix.z <= 0.0) continue;
      float d = length(sp - pix.xy) * 2.0;
      float flick = 0.75 + 0.25 * sin(time * 30.0 + pix.x * 47.0);
      vec3 pixColor = oklchToRgb(0.84, 0.13, accent.z + 95.0 + pix.w + hueTravel * 0.4);
      col += pixColor * (exp(-d * d * 2600.0) + exp(-d * d * 90.0) * 0.3) * pix.z * flick * 0.6;
    }

    gl_FragColor = vec4(col, 1.0);
  }
`;

const PRESENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform sampler2D tex;
  uniform vec2 res;
  uniform float time;
  uniform sampler2D bloom;
  uniform float level;
  uniform float beat;

  void main() {
    vec2 dir = vUv - 0.5;
    // Chromatic aberration, beat-gated: the kick splits the channels radially
    // for a moment, then the picture resolves to razor sharp. Clarity lives
    // between the beats; the energy lives on them.
    float split = 0.012 * beat;
    vec3 col = vec3(
      texture2D(tex, clamp(vUv + dir * split, 0.02, 0.98)).r,
      texture2D(tex, vUv).g,
      texture2D(tex, clamp(vUv - dir * split, 0.02, 0.98)).b
    );
    // MilkDrop's video echo: a soft, flipped, slightly zoomed second image
    // ghosting under the frame. Louder music raises the ghost.
    vec2 echoUv = clamp(((vec2(vUv.x, 1.0 - vUv.y) - 0.5) * 0.84 + 0.5), 0.02, 0.98);
    col += texture2D(tex, echoUv).rgb * 0.12 * (0.3 + 0.7 * level);
    col += texture2D(bloom, vUv).rgb * 0.5;
    // Anamorphic flare: the bloom pyramid spread along one axis, luminance
    // weighted, so only the hottest cores grow the horizontal glint and no
    // new element is drawn — the existing light just gets a lens.
    vec3 streak = texture2D(bloom, vUv).rgb;
    streak += texture2D(bloom, vUv + vec2(0.035, 0.0)).rgb * 0.8;
    streak += texture2D(bloom, vUv - vec2(0.035, 0.0)).rgb * 0.8;
    streak += texture2D(bloom, vUv + vec2(0.09, 0.0)).rgb * 0.45;
    streak += texture2D(bloom, vUv - vec2(0.09, 0.0)).rgb * 0.45;
    streak /= 3.5;
    float streakLum = max(streak.r, max(streak.g, streak.b));
    col += streak * streakLum * (0.22 + 0.45 * beat);
    col = 1.0 - exp(-col * 1.15);
    vec2 p = vUv - 0.5;
    p.x *= res.x / max(res.y, 1.0);
    col *= 0.42 + 0.58 * smoothstep(1.05, 0.3, length(p) * 1.5);
    float grain = fract(sin(dot(vUv + fract(time * 0.31), vec2(12.9898, 78.233))) * 43758.5453);
    col += (grain - 0.5) * (2.0 / 255.0);
    gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
  }
`;

/**
 * The bloom pyramid, MilkDrop's blur1..3: bright pixels are split off at a
 * quarter resolution, blurred horizontally then vertically, and added back in
 * the present pass. The glow then spreads in feathered halos instead of only
 * through the feedback decay.
 */
const BRIGHT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform sampler2D tex;
  uniform float threshold;

  void main() {
    vec3 col = texture2D(tex, vUv).rgb;
    float lum = max(max(col.r, col.g), col.b);
    gl_FragColor = vec4(col * max(0.0, (lum - threshold) / max(lum, 1e-4)), 1.0);
  }
`;

const BLUR_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;

  uniform sampler2D tex;
  uniform vec2 dir;

  void main() {
    vec3 sum = texture2D(tex, vUv).rgb * 0.227027;
    sum += (texture2D(tex, vUv + dir * 1.3846).rgb + texture2D(tex, vUv - dir * 1.3846).rgb) * 0.3162162;
    sum += (texture2D(tex, vUv + dir * 3.2308).rgb + texture2D(tex, vUv - dir * 3.2308).rgb) * 0.0702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

/**
 * Looks the scene can live in, in the spirit of MilkDrop presets: each set of
 * numbers re-weights the same drawing, and the engine crossfades between them
 * so the picture reinvents itself every so often.
 */
interface VisualizerPreset {
  name: string;
  /** Warp-field strength multiplier. */
  warp: number;
  /** Spin gain multiplier. */
  spin: number;
  /** Hue fan across the mirrored spectrum, degrees. */
  fan: number;
  /** Bar tip reach multiplier. */
  reach: number;
  /** Aurora dust emission multiplier. */
  dust: number;
  /** Aurora drift speed multiplier. */
  sway: number;
  /** Waveform-ring amplitude multiplier. */
  waveAmp: number;
  /** Shockwave strength multiplier. */
  shock: number;
  /** Palette wander speed multiplier. */
  travel: number;
  /** 3D stage visibility multiplier. */
  stage: number;
  /** Camera motion multiplier. */
  cam: number;
  /** Particle cloud brightness multiplier. */
  parts: number;
}

export const VISUALIZER_PRESETS: VisualizerPreset[] = [
  { name: "Sunflower", warp: 0.55, spin: 1.0, fan: 115, reach: 1.0, dust: 1.0, sway: 1.0, waveAmp: 1.0, shock: 1.0, travel: 1.0, stage: 0.8, cam: 0.8, parts: 0.8 },
  {
    name: "Aurora", warp: 0.45, spin: 0.5, fan: 70, reach: 0.7, dust: 2.3, sway: 2.4, waveAmp: 0.85, shock: 0.45, travel: 0.7, stage: 0.55, cam: 0.5, parts: 1.5,
  },
  { name: "Supernova", warp: 1.3, spin: 1.6, fan: 150, reach: 1.3, dust: 0.7, sway: 1.2, waveAmp: 1.15, shock: 1.7, travel: 1.4, stage: 1.05, cam: 1.25, parts: 0.9 },
  {
    name: "Reactor", warp: 0.9, spin: 1.0, fan: 95, reach: 1.05, dust: 0.8, sway: 1.0, waveAmp: 1.0, shock: 1.35, travel: 1.15, stage: 1.3, cam: 1.7, parts: 1.4,
  },
];

declare global {
  interface Window {
    /** Dev surface: jump straight to a preset index for tuning. */
    __vizPreset?: (index: number) => void;
    __vizPresetNames?: string[];
  }
}
if (import.meta.env.DEV) {
  window.__vizPresetNames = VISUALIZER_PRESETS.map((preset) => preset.name);
}

/** Builds the renderer and the two fullscreen passes. Null when WebGL is not there. */
export const createVisualizerEngine = (host: HTMLElement, accent: [number, number, number]): VisualizerEngine | null => {
  const canvas = document.createElement("canvas");
  canvas.className = "block h-full w-full";
  host.appendChild(canvas);

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
  } catch (error) {
    console.warn("Visualizer could not start WebGL", error);
    canvas.remove();
    return null;
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);

  const readUniforms = {
    prev: { value: null as THREE.Texture | null },
    res: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    dt: { value: 1 / 60 },
    accent: { value: new THREE.Vector3(accent[0], accent[1], accent[2]) },
    bass: { value: 0 },
    mid: { value: 0 },
    treble: { value: 0 },
    level: { value: 0 },
    beat: { value: 0 },
    pulseAge: { value: 1e3 },
    quake: { value: 0 },
    quakeAge: { value: 1e3 },
    quakePos: { value: new THREE.Vector2() },
    shockPos: { value: new THREE.Vector2() },
    pixies: { value: Array.from({ length: PIXIE_COUNT }, () => new THREE.Vector4(0, 0, 0, 0)) },
    soundCenter: { value: 0.35 },
    bassAtt: { value: 0 },
    midAtt: { value: 0 },
    trebAtt: { value: 0 },
    spectrum: { value: new Float32Array(BAND_COUNT) },
    peaks: { value: new Float32Array(BAND_COUNT) },
    wave: { value: new Float32Array(WAVE_SAMPLES) },
    stage: { value: null as THREE.Texture | null },
    pWarp: { value: 1 },
    pSpin: { value: 1 },
    pFan: { value: 115 },
    pReach: { value: 1 },
    pDust: { value: 1 },
    pSway: { value: 1 },
    pWaveAmp: { value: 1 },
    pShock: { value: 1 },
    pTravel: { value: 1 },
    pStage: { value: 1 },
    pCam: { value: 1 },
    pParts: { value: 1 },
  };
  const presentUniforms = {
    tex: { value: null as THREE.Texture | null },
    // Same wrapper as the composite pass: both sample at the buffer size.
    res: readUniforms.res,
    time: { value: 0 },
    bloom: { value: null as THREE.Texture | null },
    level: { value: 0 },
    beat: { value: 0 },
  };
  const brightUniforms = {
    tex: { value: null as THREE.Texture | null },
    threshold: { value: 0.45 },
  };
  const blurUniforms = {
    tex: { value: null as THREE.Texture | null },
    dir: { value: new THREE.Vector2() },
  };

  const readMaterial = new THREE.ShaderMaterial({
    uniforms: readUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: COMPOSITE_SHADER,
    depthTest: false,
    depthWrite: false,
  });
  const presentMaterial = new THREE.ShaderMaterial({
    uniforms: presentUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: PRESENT_SHADER,
    depthTest: false,
    depthWrite: false,
  });
  const brightMaterial = new THREE.ShaderMaterial({
    uniforms: brightUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: BRIGHT_SHADER,
    depthTest: false,
    depthWrite: false,
  });
  const blurMaterial = new THREE.ShaderMaterial({
    uniforms: blurUniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: BLUR_SHADER,
    depthTest: false,
    depthWrite: false,
  });

  const readScene = new THREE.Scene();
  readScene.add(new THREE.Mesh(geometry, readMaterial));
  const presentScene = new THREE.Scene();
  presentScene.add(new THREE.Mesh(geometry, presentMaterial));
  const brightScene = new THREE.Scene();
  brightScene.add(new THREE.Mesh(geometry, brightMaterial));
  const blurScene = new THREE.Scene();
  blurScene.add(new THREE.Mesh(geometry, blurMaterial));

  // === The 3D stage: a world the camera flies through, rendered into its own
  // target so the composite pass can light it with the same feedback, bloom
  // and anti-bloom as the 2D field. Bars on the ring, the reactor core, a
  // particle nebula, the waveform ribbon and a grid horizon.
  const stageCamera = new THREE.PerspectiveCamera(62, 1, 0.5, 400);
  const stageScene = new THREE.Scene();
  const stageTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });
  readUniforms.stage.value = stageTarget.texture;

  // The accent, converted in JS with the same math the shaders use, for
  // materials that want per-frame colors directly.
  const accentInJs = (lightness: number, chroma: number, hueDeg: number): [number, number, number] => {
    const h = (hueDeg * Math.PI) / 180;
    const hr = Math.cos(h) * chroma;
    const hg = Math.sin(h) * chroma;
    const cube = (x: number) => {
      const v = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
      return Math.min(1, Math.max(0, v));
    };
    const l_ = Math.pow(lightness + 0.3963377774 * hr + 0.2158037573 * hg, 3);
    const m_ = Math.pow(lightness - 0.1055613458 * hr - 0.0638541728 * hg, 3);
    const s_ = Math.pow(lightness - 0.0894841775 * hr - 1.291485548 * hg, 3);
    return [
      cube(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
      cube(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
      cube(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    ];
  };

  // The equalizer ring: instanced bars standing on a circle, heights from the
  // bands, mirrored so the ring is symmetric like the 2D one.
  const BAR_RING = 72;
  const barGeometry = new THREE.BoxGeometry(0.72, 1, 0.72);
  const barMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  const bars = new THREE.InstancedMesh(barGeometry, barMaterial, BAR_RING);
  bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stageScene.add(bars);
  const barDummy = new THREE.Object3D();
  const barColor = new THREE.Color();

  // Value lookup mirroring the shader's bandAt: linear between the
  // log-spaced bands across the mirrored angle.
  const bandValue = (mirror01: number) => {
    const k = Math.min(BAND_COUNT - 1.001, Math.max(0, mirror01 * (BAND_COUNT - 1)));
    const j = Math.floor(k);
    return frame_bandLerp(j, k - j);
  };
  let _frameBands = new Float32Array(BAND_COUNT);
  const frame_bandLerp = (j: number, f: number) => _frameBands[j] + f * (_frameBands[j + 1] - _frameBands[j]);

  // The reactor core: a wireframe icosahedron whose vertices spike with the
  // bass and breathe with the beat — the fresnel-anomaly look, with the
  // noise displacement done with cheap trig instead of a simplex copy.
  const coreUniforms = {
    time: { value: 0 },
    level: { value: 0 },
    beat: { value: 0 },
    amp: { value: 1 },
    hue: { value: 27 },
  };
  const coreGeometry = new THREE.IcosahedronGeometry(3.4, 4);
  const coreMaterial = new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: /* glsl */ `
      uniform float time;
      uniform float level;
      uniform float beat;
      uniform float amp;
      varying float vSpike;

      void main() {
        vec3 pos = position;
        float d =
          sin(position.x * 1.7 + time * 1.05) *
          sin(position.y * 2.1 - time * 0.87) *
          sin(position.z * 1.9 + time * 0.71);
        pos += normal * d * amp * (0.28 + 1.15 * level + 1.6 * beat);
        vSpike = d;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float level;
      uniform float beat;
      uniform float hue;
      varying float vSpike;

      ${OKLCH_GLSL}

      void main() {
        vec3 color = oklchToRgb(0.72, 0.17, hue + vSpike * 22.0);
        gl_FragColor = vec4(color * (0.10 + 0.40 * level + 0.95 * beat) * (0.8 + 0.35 * vSpike), 1.0);
      }
    `,
    wireframe: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const core = new THREE.Mesh(coreGeometry, coreMaterial);
  // Off the floor and out of the ribbon's plane: the centre of the arena is
  // where every ring converges, so the core floats above them instead of
  // welding them into one pile.
  core.position.set(0, 5, 0);
  stageScene.add(core);

  // The particle nebula: one Points cloud whose orbit the vertex shader
  // integrates — position spirals seeded per particle, pushed outward on the
  // beat, sized by distance.
  const PART_COUNT = 2800;
  const partSeed = new Float32Array(PART_COUNT * 4);
  for (let i = 0; i < PART_COUNT; i++) {
    partSeed[i * 4] = Math.random() * Math.PI * 2;
    partSeed[i * 4 + 1] = Math.pow(Math.random(), 0.7);
    partSeed[i * 4 + 2] = Math.random();
    partSeed[i * 4 + 3] = 0.7 + Math.random() * 1.7;
  }
  const partGeometry = new THREE.BufferGeometry();
  partGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(PART_COUNT * 3), 3));
  partGeometry.setAttribute("aSeed", new THREE.BufferAttribute(partSeed, 4));
  const partUniforms = {
    time: { value: 0 },
    level: { value: 0 },
    beat: { value: 0 },
    bass: { value: 0 },
    treble: { value: 0 },
    hueShift: { value: 0 },
    scale: { value: 1 },
    center: { value: new THREE.Vector2() },
  };
  const partMaterial = new THREE.ShaderMaterial({
    uniforms: partUniforms,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float time;
      uniform float beat;
      uniform float bass;
      uniform vec2 center;
      uniform float scale;
      varying float vSeed;

      void main() {
        float ang = aSeed.x + time * (0.05 + aSeed.z * 0.08);
        // The nebula is the basses' own body: it collapses inward under the
        // kick's weight while the towers reach, the inverse of a push — and
        // it nests off-axis, so the cloud doesn't crowd the tower ring.
        float rad = (6.5 + pow(aSeed.y, 1.35) * 19.0) * (1.0 - 0.16 * bass) * (1.0 + 0.45 * beat * aSeed.z);
        float y = (aSeed.z * 2.0 - 1.0) * 5.5 - 3.0 * beat * aSeed.z;
        vec3 pos = vec3(cos(ang) * rad + center.x, y + 1.6 * sin(time * (0.25 + aSeed.z) + aSeed.x * 2.1), sin(ang) * rad + center.y);
        pos *= scale;
        vec4 mv = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = aSeed.w * scale * (88.0 / max(1.0, -mv.z)) * (1.0 + 0.9 * beat);
        gl_Position = projectionMatrix * mv;
        vSeed = aSeed.z;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      uniform float time;
      uniform float level;
      uniform float treble;
      uniform float hueShift;
      varying float vSeed;

      ${OKLCH_GLSL}

      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float falloff = exp(-d * d * 14.0) * (1.0 - d * d);
        if (falloff <= 0.0) discard;
        vec3 color = oklchToRgb(0.7, 0.15, time * 1.4 + hueShift + vSeed * 90.0);
        // Treble makes the cloud glitter: a fast per-particle flicker the
        // hats drive, so high registers have a texture of their own.
        float twinkle = 1.0 + treble * 1.4 * max(0.0, sin(time * 24.0 + vSeed * 130.0));
        gl_FragColor = vec4(color * ((0.05 + 0.16 * level + 0.28 * vSeed) * twinkle), 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const particles = new THREE.Points(partGeometry, partMaterial);
  particles.frustumCulled = false;
  stageScene.add(particles);

  // The waveform ribbon: the song's own shape lifted into 3D as a floating
  // ring of 256 points, displaced vertically by the samples.
  const ribbonGeometry = new THREE.BufferGeometry();
  ribbonGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(WAVE_SAMPLES * 3), 3));
  const ribbonMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const ribbon = new THREE.LineLoop(ribbonGeometry, ribbonMaterial);
  ribbon.frustumCulled = false;
  stageScene.add(ribbon);

  // The grid horizon: concentric rings and spokes at y=-2, faint enough to
  // ground the space without reading as architecture.
  const gridLines: number[] = [];
  for (const radius of [13, 19, 26, 34]) {
    const steps = 96;
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      gridLines.push(Math.cos(a0) * radius, -2, Math.sin(a0) * radius, Math.cos(a1) * radius, -2, Math.sin(a1) * radius);
    }
  }
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    gridLines.push(Math.cos(a) * 13, -2, Math.sin(a) * 13, Math.cos(a) * 34, -2, Math.sin(a) * 34);
  }
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(gridLines), 3));
  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.13,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const grid = new THREE.LineSegments(gridGeometry, gridMaterial);
  stageScene.add(grid);

  // Stage update, once per frame: heights, colors, uniforms, the camera.
  const stageAngle = { value: 0 };
  const updateStage = (frame: VisualizerFrame, timeSeconds: number, dt: number) => {
    _frameBands = frame.spectrum;

    // Camera choreography: the orbit integrates slowly and the beat pushes
    // the turn; radius falls with loudness (closer feels heavier), height
    // breathes over the bar tops, FOV punches with the kick, a slight roll
    // sells the flight.
    stageAngle.value += dt * (0.055 + 0.5 * frame.beat) * params.cam;
    // Radius falls with loudness (closer feels heavier) from a base wide
    // enough to hold the broad tower ring in frame. The look target lags the
    // orbit by a fixed bearing, so the frame leads with one side of the arena
    // instead of pinning the whole ring behind the centre point.
    const camDist = 51 - 10 * frame.level - 3.2 * frame.beat;
    const camHeight = 2.5 + 9 * Math.pow(0.5 + 0.5 * Math.sin(timeSeconds * 0.067), 2) * (0.6 + 0.4 * params.cam);
    stageCamera.position.set(
      Math.cos(stageAngle.value) * camDist,
      camHeight + 2.5 * frame.beat,
      Math.sin(stageAngle.value) * camDist,
    );
    stageCamera.lookAt(
      Math.cos(stageAngle.value + 0.9) * 5,
      3.4,
      Math.sin(stageAngle.value + 0.9) * 5,
    );
    stageCamera.rotateZ(Math.sin(timeSeconds * 0.13) * 0.06 + 0.05 * frame.beat);
    stageCamera.fov = 62 - 6 * frame.beat;
    stageCamera.updateProjectionMatrix();

    // Bars.
    const accentZ = accent[2];
    const hueTravel = timeSeconds * 2.5 * params.travel + frame.soundCenter * 70;
    for (let i = 0; i < BAR_RING; i++) {
      const mirror01 = i < BAR_RING / 2 ? i / (BAR_RING / 2) : 2 - (i / (BAR_RING / 2));
      const value = bandValue(mirror01);
      const angle = (i / BAR_RING) * Math.PI * 2 - Math.PI / 2;
      const height = 1.1 + 17 * Math.pow(value, 1.4) * (0.85 + 0.3 * frame.level);
      // A wide ring: the towers fan out past the camera's frame instead of
      // bunching around the middle, so the stage reads as a broad arena.
      const radius = 17.5;
      barDummy.position.set(Math.cos(angle) * radius, height / 2 - 2, Math.sin(angle) * radius);
      barDummy.scale.set(1, height, 1);
      barDummy.updateMatrix();
      bars.setMatrixAt(i, barDummy.matrix);
      // Near bars sit huge on screen; dim them by camera distance so the
      // closest tower cannot saturate to white, far ones keep their glow.
      const distCam = stageCamera.position.distanceTo(barDummy.position);
      const nearDim = 0.5 + 0.5 * Math.min(1, Math.max(0, (distCam - 16) / 28));
      const hue = accentZ + hueTravel * 0.6 + mirror01 * params.fan * (0.4 + 0.6 * frame.level) + frame.bass * 8;
      const [r, g, b] = accentInJs(0.62 + value * 0.14, 0.2, hue);
      const glow = (0.025 + 0.22 * value) * nearDim;
      // Cap each channel under the bloom threshold's neighbourhood: a tower
      // whose colour all lands above 0.85 blooms into one white slab.
      bars.setColorAt(i, barColor.setRGB(Math.min(0.85, r * glow), Math.min(0.85, g * glow), Math.min(0.85, b * glow)));
    }
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;

    // Core, nebula and ribbon uniforms.
    coreUniforms.time.value = timeSeconds;
    coreUniforms.level.value = frame.level;
    coreUniforms.beat.value = frame.beat;
    coreUniforms.amp.value = params.stage;
    coreUniforms.hue.value = accentZ + hueTravel;
    partUniforms.time.value = timeSeconds;
    partUniforms.level.value = frame.level;
    partUniforms.beat.value = frame.beat;
    partUniforms.bass.value = frame.bass;
    partUniforms.treble.value = frame.treble;
    partUniforms.hueShift.value = accentZ + hueTravel;
    partUniforms.scale.value = 1 + 0.5 * (params.cam - 1);
    // The cloud drifts slowly around the tower ring, so camera passes see it
    // nest beside the towers instead of behind them every time — the wander
    // reaches past the ring, keeping the middle from piling up.
    partUniforms.center.value.set(Math.sin(timeSeconds * 0.033) * 8.0, Math.cos(timeSeconds * 0.027) * 8.0);
    partMaterial.opacity = 1;
    // The floor pounds on every kick: the grid brightens with the beat and
    // settles between them, grounding the space in the rhythm.
    gridMaterial.opacity = (0.1 + 0.45 * frame.beat) * params.stage;
    grid.rotation.y = timeSeconds * 0.02;

    const wavePos = ribbonGeometry.getAttribute("position") as THREE.BufferAttribute;
    const waveArr = wavePos.array as Float32Array;
    const ribbonRadius = 12.5;
    const waveScale = (1.0 + 3.2 * frame.level) * params.waveAmp;
    for (let i = 0; i < WAVE_SAMPLES; i++) {
      const phi = (i / WAVE_SAMPLES) * Math.PI * 2;
      const s = (phi / (Math.PI * 2) + 0.75) % 1;
      const mirrored = s < 0.5 ? s * 2 : (1 - s) * 2;
      const w = frame.wave[Math.min(WAVE_SAMPLES - 1, Math.floor(mirrored * (WAVE_SAMPLES - 1)))];
      waveArr[i * 3] = Math.cos(phi) * ribbonRadius;
      waveArr[i * 3 + 1] = w * waveScale;
      waveArr[i * 3 + 2] = Math.sin(phi) * ribbonRadius;
    }
    wavePos.needsUpdate = true;
    const [rr, rg, rb] = accentInJs(0.68 + 0.12 * frame.level, 0.17, accentZ - 90 + hueTravel);
    ribbonMaterial.color.setRGB(rr, rg, rb);
    ribbonMaterial.opacity = Math.min(1, 0.35 + 0.5 * frame.level);
  };


  // The feedback ping-pong. The shader reads one target while writing the other.
  const makeTarget = () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, stencilBuffer: false });
  let read = 0;
  const targets = [makeTarget(), makeTarget()];
  // Bloom runs at a quarter resolution: the blur forgives it and it keeps the
  // three extra passes off the full-res budget.
  const brightTarget = makeTarget();
  const blurATarget = makeTarget();
  const blurBTarget = makeTarget();

  // Preset state: the live parameters chase the current preset, so moving to
  // the next look is a crossfade inside the same shader.
  const paramKeys = ["warp", "spin", "fan", "reach", "dust", "sway", "waveAmp", "shock", "travel", "stage", "cam", "parts"] as const;
  type ParamKey = (typeof paramKeys)[number];
  const params = paramKeys.reduce((acc, key) => {
    acc[key] = VISUALIZER_PRESETS[0][key];
    return acc;
  }, {} as Record<ParamKey, number>);
  let presetIdx = 0;
  let presetTimer = 0;
  const PRESET_SECONDS = 38;
  const paramUniformKey: Record<ParamKey, string> = {
    warp: "pWarp",
    spin: "pSpin",
    fan: "pFan",
    reach: "pReach",
    dust: "pDust",
    sway: "pSway",
    waveAmp: "pWaveAmp",
    shock: "pShock",
    travel: "pTravel",
    stage: "pStage",
    cam: "pCam",
    parts: "pParts",
  };

  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
    readUniforms.res.value.set(buffer.x, buffer.y);
    targets[0].setSize(buffer.x, buffer.y);
    targets[1].setSize(buffer.x, buffer.y);
    const bw = Math.max(1, Math.ceil(buffer.x / 4));
    const bh = Math.max(1, Math.ceil(buffer.y / 4));
    brightTarget.setSize(bw, bh);
    blurATarget.setSize(bw, bh);
    blurBTarget.setSize(bw, bh);
    stageTarget.setSize(buffer.x, buffer.y);
    stageCamera.aspect = buffer.x / Math.max(1, buffer.y);
    stageCamera.updateProjectionMatrix();
  };

  const render = (frame: VisualizerFrame, timeSeconds: number, dt: number) => {
    // Preset crossfade: ease the params toward the preset's values, and walk
    // to the next look every PRESET_SECONDS so the eye never settles.
    const target = VISUALIZER_PRESETS[presetIdx];
    const ease = Math.min(1, dt / 1.1);
    for (const key of paramKeys) {
      params[key] += (target[key] - params[key]) * ease;
      const uniform = readUniforms[paramUniformKey[key] as keyof typeof readUniforms] as { value: number };
      uniform.value = params[key];
    }
    presetTimer += dt;
    if (presetTimer > PRESET_SECONDS) {
      presetTimer = 0;
      presetIdx = (presetIdx + 1) % VISUALIZER_PRESETS.length;
    }

    // The stage draws first: its full-res texture feeds the composite below.
    updateStage(frame, timeSeconds, dt);
    renderer.setRenderTarget(stageTarget);
    renderer.render(stageScene, stageCamera);

    const readTarget = targets[read];
    const writeTarget = targets[1 - read];
    readUniforms.prev.value = readTarget.texture;
    readUniforms.time.value = timeSeconds;
    readUniforms.dt.value = dt;
    readUniforms.bass.value = frame.bass;
    readUniforms.mid.value = frame.mid;
    readUniforms.treble.value = frame.treble;
    readUniforms.level.value = frame.level;
    readUniforms.beat.value = frame.beat;
    readUniforms.pulseAge.value = frame.pulseAge;
    readUniforms.quake.value = frame.quake;
    readUniforms.quakeAge.value = frame.quakeAge;
    readUniforms.quakePos.value = frame.quakePos;
    readUniforms.shockPos.value = frame.shockPos;
    readUniforms.pixies.value = frame.pixies;
    readUniforms.soundCenter.value = frame.soundCenter;
    readUniforms.bassAtt.value = frame.bassAtt;
    readUniforms.midAtt.value = frame.midAtt;
    readUniforms.trebAtt.value = frame.trebAtt;
    readUniforms.spectrum.value = frame.spectrum;
    readUniforms.peaks.value = frame.peaks;
    readUniforms.wave.value = frame.wave;
    renderer.setRenderTarget(writeTarget);
    renderer.render(readScene, camera);
    read = 1 - read;

    // The bloom chain: quarter-res bright cut, blur horizontally, blur
    // vertically, and the present pass adds it back over the full picture.
    brightUniforms.tex.value = writeTarget.texture;
    renderer.setRenderTarget(brightTarget);
    renderer.render(brightScene, camera);
    blurUniforms.tex.value = brightTarget.texture;
    blurUniforms.dir.value.set(1 / brightTarget.width, 0);
    renderer.setRenderTarget(blurATarget);
    renderer.render(blurScene, camera);
    blurUniforms.tex.value = blurATarget.texture;
    blurUniforms.dir.value.set(0, 1 / blurATarget.height);
    renderer.setRenderTarget(blurBTarget);
    renderer.render(blurScene, camera);
    presentUniforms.bloom.value = blurBTarget.texture;

    presentUniforms.tex.value = writeTarget.texture;
    presentUniforms.time.value = timeSeconds;
    presentUniforms.level.value = frame.level;
    presentUniforms.beat.value = frame.beat;
    renderer.setRenderTarget(null);
    renderer.render(presentScene, camera);
  };

  const dispose = () => {
    targets.forEach((target) => target.dispose());
    brightTarget.dispose();
    blurATarget.dispose();
    blurBTarget.dispose();
    stageTarget.dispose();
    geometry.dispose();
    readMaterial.dispose();
    presentMaterial.dispose();
    brightMaterial.dispose();
    blurMaterial.dispose();
    barGeometry.dispose();
    barMaterial.dispose();
    coreGeometry.dispose();
    coreMaterial.dispose();
    partGeometry.dispose();
    partMaterial.dispose();
    ribbonGeometry.dispose();
    ribbonMaterial.dispose();
    gridGeometry.dispose();
    gridMaterial.dispose();
    renderer.dispose();
    canvas.remove();
  };

  // Dev surface: make the live uniforms inspectable from `cli.py eval`, and
  // let a tuning run jump straight to a preset.
  if (import.meta.env.DEV) {
    window.__vizUniforms = readUniforms;
    window.__vizPreset = (index: number) => {
      presetIdx = ((index % VISUALIZER_PRESETS.length) + VISUALIZER_PRESETS.length) % VISUALIZER_PRESETS.length;
      presetTimer = 0;
    };
  }

  return { render, resize, dispose };
};
