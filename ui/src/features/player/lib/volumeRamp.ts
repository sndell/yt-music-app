/**
 * A timed volume ramp, driven by animation frames.
 *
 * Playback level is ramped on the elements themselves rather than through a
 * Web Audio graph: `createMediaElementSource` needs a same-origin or CORS
 * response, and googlevideo sends neither for these streams, so the graph
 * would play silence. `volume` has no such limit, and sixty steps a second is
 * smooth enough that the steps are not audible.
 */

export interface Ramp {
  /** Stops the ramp where it stands; neither callback runs again. */
  cancel(): void;
}

/**
 * Calls `onFrame` with the ramp's progress, ending at exactly 1, then
 * `onComplete`. A length of zero finishes in the same tick, which is how a
 * preloaded next track is handed over with no gap at all.
 */
export const rampVolumes = ({
  lengthMs,
  onFrame,
  onComplete,
}: {
  lengthMs: number;
  onFrame: (progress: number) => void;
  onComplete: () => void;
}): Ramp => {
  let frame = 0;
  let running = true;
  const startedAt = performance.now();

  const step = () => {
    if (!running) return;
    const progress = lengthMs > 0 ? Math.min(1, (performance.now() - startedAt) / lengthMs) : 1;
    onFrame(progress);
    if (progress >= 1) {
      running = false;
      onComplete();
      return;
    }
    frame = requestAnimationFrame(step);
  };

  if (lengthMs > 0) frame = requestAnimationFrame(step);
  else step();

  return {
    cancel() {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
};
