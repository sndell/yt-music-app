/** Playback facts and transport, published by the window that owns the audio.
 *
 * `isPlaying`, position, duration, loop and volume are local to `Player.tsx`,
 * because that is where the `<audio>` element lives. A second surface cannot
 * read them, and giving it its own `<audio>` would play every song twice and
 * write the account's history twice. This store is the smallest thing that
 * closes the gap: `Player` writes, the popout bridge reads, and the transport
 * handlers drive the same element the player bar drives.
 *
 * A module singleton like `playhead`, not a context: the only writer is the
 * player, and the only reader is the popout bridge.
 */

export type PlaybackState = {
  playing: boolean;
  position: number;
  duration: number;
  loop: boolean;
};

export type PlaybackTransport = {
  play: () => void;
  pause: () => void;
  seek: (position: number) => void;
  next: () => void;
  previous: () => void;
  toggleLoop: () => void;
};

let state: PlaybackState = {
  playing: false,
  position: 0,
  duration: 0,
  loop: false,
};

let transport: PlaybackTransport | null = null;

const listeners = new Set<(state: PlaybackState) => void>();

export const playback = {
  get: () => state,
  /** Merge one change and notify. The object is replaced, so readers can compare. */
  publish(patch: Partial<PlaybackState>) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  },
  subscribe(listener: (state: PlaybackState) => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The player registers these while it is mounted; a remote surface calls them. */
  setTransport(next: PlaybackTransport | null) {
    transport = next;
  },
  transport: () => transport,
};
