/**
 * Playback position, kept out of React state.
 *
 * The lyrics view needs the position on every tick, but a state field for it
 * would re-render the whole player tree several times a second. Subscribers
 * read the value on a tick and re-render only when what they show changes.
 */
let seconds = 0;
const listeners = new Set<() => void>();

/** The player's seek implementation, set once Player mounts. */
let seeker: ((seconds: number) => void) | null = null;

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
  /**
   * Moves the playback to `seconds` through the player's own seek. The audio
   * element is private to Player, so callers ask instead of reaching the node.
   */
  seek(seconds: number) {
    seeker?.(seconds);
  },
  setSeeker(implement: (seconds: number) => void) {
    seeker = implement;
  },
};
