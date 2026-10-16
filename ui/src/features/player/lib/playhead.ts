/**
 * Playback position, kept out of React state.
 *
 * The lyrics view needs the position on every tick, but a state field for it
 * would re-render the whole player tree several times a second. Subscribers
 * read the value on a tick and re-render only when what they show changes.
 */
let seconds = 0;
const listeners = new Set<() => void>();

export const playhead = {
  get: () => seconds,
  set(value: number) {
    if (value === seconds) return;
    seconds = value;
    for (const listener of listeners) listener();
  },
  /** Clears back to the start, for when a new song loads. */
  reset() {
    playhead.set(0);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
