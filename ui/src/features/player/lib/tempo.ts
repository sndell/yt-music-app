/**
 * Where a song's beat falls, measured from the opening of its stream.
 *
 * Decoding has to happen here: the playing element is cross-origin, so it
 * cannot be captured into Web Audio, and Python has no decoder. A prefix of the
 * file is enough because both containers stream, and 1 MB covers 20 to 30
 * seconds at the offered bitrates — measured, 1.2 MB decoded to 37 seconds.
 */

export interface Tempo {
  /** Beats per minute, normalised into the musical range so bars stay bars. */
  bpm: number;
  /** Seconds from the start of the track to its first beat. */
  offset: number;
  /** How strongly the beat repeats; low means the estimate is little better than a guess. */
  confidence: number;
}

/** Low enough that a 20 s clip is a couple of megabytes, high enough to keep a kick. */
const ANALYSIS_RATE = 11025;
/** Below this there is not enough music to time a beat against. */
const MIN_SECONDS = 8;
/** Two windows this far apart, so a section that contradicts the rest rejects the estimate. */
const WINDOW_SECONDS = 18;
const WINDOW_SHIFT_SECONDS = 6;
/** A tempo outside this band is moved by octaves; the grid is unchanged either way. */
const LOWEST_BPM = 70;
const HIGHEST_BPM = 150;
/** Agreement between the two windows, as a fraction of the tempo. */
const TOLERANCE = 0.03;
/** Below this the repeat is too weak to trust, whatever the two windows say. */
const MIN_CONFIDENCE = 0.2;

const frameSize = () => 256;
const windowSize = () => 1024;

export const bytesFromBase64 = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

/** One window's estimate, or null when nothing periodic stands out. */
const estimate = (samples: Float32Array, rate: number): Tempo | null => {
  const hop = frameSize();
  const frames = Math.floor(samples.length / hop) - 4;
  if (frames < 64) return null;

  // One-pole low pass at 150 Hz: the kick and the bass carry the beat, and
  // melody or vocals moving the envelope would time the wrong thing.
  const cutoff = 1 - Math.exp((-2 * Math.PI * 150) / rate);
  const low = new Float32Array(samples.length);
  let state = 0;
  for (let index = 0; index < samples.length; index += 1) {
    state += cutoff * (samples[index] - state);
    low[index] = state;
  }

  // Energy per frame, then its positive log difference: an onset is a jump.
  const envelope = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let energy = 0;
    const start = frame * hop;
    for (let index = 0; index < windowSize(); index += 2) energy += low[start + index] * low[start + index];
    envelope[frame] = Math.sqrt(energy / (windowSize() / 2));
  }
  const onset = new Float32Array(frames);
  for (let frame = 1; frame < frames - 1; frame += 1) {
    const rise = Math.log(1e-7 + envelope[frame]) - Math.log(1e-7 + envelope[frame - 1]);
    onset[frame] = Math.max(0, rise);
  }

  const framesPerSecond = rate / hop;
  const correlation = (lag: number) => {
    let total = 0;
    for (let index = lag; index < frames; index += 1) total += onset[index] * onset[index - lag];
    return total / Math.max(1, frames - lag);
  };

  const shortest = Math.round((60 / HIGHEST_BPM) * framesPerSecond);
  const longest = Math.round((60 / LOWEST_BPM) * framesPerSecond);
  let best = -Infinity;
  let period = shortest;
  for (let lag = shortest; lag <= longest; lag += 1) {
    // A gentle pull towards 115 BPM, which keeps a bar from being mistaken for
    // its own half or a sixteenth-note for the beat.
    const bpm = (60 * framesPerSecond) / lag;
    const prior = Math.exp(-Math.pow(Math.log(bpm / 115) / 0.5, 2));
    const score = correlation(lag) * prior;
    if (score > best) {
      best = score;
      period = lag;
    }
  }

  // The half and double lags describe the same grid; take one of them when it
  // repeats almost as strongly, so every song lands in the same octave.
  const half = Math.round(period / 2);
  const double = Math.round(period * 2);
  if (half >= shortest && correlation(half) > best * 0.85) period = half;
  else if (double <= longest && correlation(double) > best * 0.92) period = double;

  let flat = 0;
  for (let frame = 0; frame < frames; frame += 1) flat += onset[frame] * onset[frame];
  flat /= frames;
  const confidence = flat > 0 ? correlation(period) / flat : 0;

  // The beat is the phase of the period with the most onset in it.
  let phase = 0;
  let strongest = -1;
  for (let candidate = 0; candidate < period; candidate += 1) {
    let total = 0;
    for (let frame = candidate; frame < frames; frame += period) total += onset[frame];
    if (total > strongest) {
      strongest = total;
      phase = candidate;
    }
  }

  let bpm = (60 * framesPerSecond) / period;
  while (bpm < LOWEST_BPM) bpm *= 2;
  while (bpm > HIGHEST_BPM) bpm /= 2;
  return { bpm, offset: (phase * hop) / rate, confidence };
};

const mixdown = (buffer: AudioBuffer, from: number, seconds: number) => {
  const rate = buffer.sampleRate;
  const start = Math.min(buffer.length, Math.round(from * rate));
  const end = Math.min(buffer.length, start + Math.round(seconds * rate));
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const mono = new Float32Array(Math.max(0, end - start));
  for (let index = 0; index < mono.length; index += 1) {
    const value = left[start + index];
    mono[index] = right ? (value + right[start + index]) * 0.5 : value;
  }
  return { mono, rate };
};

/**
 * Reads a stream's opening bytes and returns its beat, or null when the
 * estimate is not worth acting on. Callers fall back to a plain crossfade.
 */
export const tempoFromBytes = async (bytes: Uint8Array): Promise<Tempo | null> => {
  const context = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  // decodeAudioData detaches the buffer it is handed, so it gets its own copy.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const buffer = await context.decodeAudioData(copy);
  if (buffer.duration < MIN_SECONDS) return null;

  const first = mixdown(buffer, 0, WINDOW_SECONDS);
  const head = estimate(first.mono, first.rate);
  if (!head || head.confidence < MIN_CONFIDENCE) return null;

  const length = buffer.length / buffer.sampleRate;
  if (length < WINDOW_SHIFT_SECONDS + MIN_SECONDS) return head;
  const second = mixdown(buffer, WINDOW_SHIFT_SECONDS, WINDOW_SECONDS);
  const tail = estimate(second.mono, second.rate);
  if (!tail || tail.confidence < MIN_CONFIDENCE) return null;
  if (Math.abs(head.bpm - tail.bpm) / tail.bpm > TOLERANCE) return null;

  return head.confidence >= tail.confidence ? head : tail;
};
