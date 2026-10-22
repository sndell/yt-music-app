/** Messages between the window that owns the player and the popout.
 *
 * Both windows are same-origin (the Vite origin in dev, the one packaged UI
 * server otherwise), so a BroadcastChannel carries them with no Python round
 * trip. The main window stays the only writer: it publishes a snapshot when the
 * song or queue changes and a small tick while the audio plays, and the popout
 * answers with commands the main window runs through its real handlers. That
 * is what keeps one queue, one like state and one history write.
 */
import type { LikeStatus, Track, WatchTrack } from "@/lib/api";
import type { SongLyrics } from "@/features/player/lib/queueModel";

export const POPOUT_CHANNEL = "ytmusic-popout";

/** Everything the popout draws, minus the clock, which travels in ticks. */
export type PopoutState = {
  song: Track | null;
  queue: WatchTrack[];
  /** Index of the playing song in `queue`, or -1 when it is not from there. */
  index: number;
  shuffle: boolean;
  loop: boolean;
  playing: boolean;
  position: number;
  duration: number;
  lyrics: SongLyrics | null;
  relatedId: string | null;
  relatedTitle: string | null;
  ratingPending: boolean;
  /** When the sender wrote `position`, so the receiver can date it. */
  sentAt: number;
};

export type PopoutCommand =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "seek"; position: number }
  | { kind: "toggle-shuffle" }
  | { kind: "toggle-loop" }
  | { kind: "rate"; rating: LikeStatus }
  | { kind: "play-index"; index: number }
  | { kind: "play-next"; track: WatchTrack }
  | { kind: "add-to-queue"; track: WatchTrack }
  | { kind: "start-mix"; track: WatchTrack }
  | { kind: "open-main"; href: string }
  | { kind: "close-popout" };

export type PopoutMessage =
  /** The popout mounted (or reconnected) and needs a snapshot. */
  | { type: "hello" }
  | { type: "state"; state: PopoutState }
  | { type: "tick"; playing: boolean; position: number; duration: number; loop: boolean }
  | { type: "command"; command: PopoutCommand };

export const EMPTY_POPOUT_STATE: PopoutState = {
  song: null,
  queue: [],
  index: -1,
  shuffle: false,
  loop: false,
  playing: false,
  position: 0,
  duration: 0,
  lyrics: null,
  relatedId: null,
  relatedTitle: null,
  ratingPending: false,
  sentAt: 0,
};
