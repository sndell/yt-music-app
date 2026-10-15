import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PyBridge } from "@/lib/api/bridge";
import type { Track } from "@/lib/api/types";
import { PlayerProvider, usePlayer } from "./PlayerContext";

vi.mock("@/lib/api/bridge", () => ({
  PyBridge: {
    getWatchPlaylist: vi.fn(),
    getQueueTuner: vi.fn(),
    getSongRating: vi.fn(),
  },
}));

const track = (overrides: Partial<Track> = {}): Track => ({
  videoId: "v1",
  title: "Song",
  artists: [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: [],
  isAvailable: true,
  isExplicit: false,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "3:00",
  durationSeconds: 180,
  setVideoId: "s1",
  ...overrides,
});

let player: ReturnType<typeof usePlayer>;

const Probe = () => {
  player = usePlayer();
  return null;
};

const setup = () => render(<PlayerProvider><Probe /></PlayerProvider>);
const message = (data: unknown) => ({ success: true, data });

describe("PlayerContext.playFromPlaylist", () => {
  beforeEach(() => {
    (PyBridge.getWatchPlaylist as Mock).mockResolvedValue(message({ tracks: [], playlistId: "PL" }));
    (PyBridge.getQueueTuner as Mock).mockResolvedValue(message([]));
    (PyBridge.getSongRating as Mock).mockResolvedValue(message({ likeStatus: "INDIFFERENT" }));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not start a track the account no longer has", () => {
    setup();

    act(() => player.playFromPlaylist(track({ isAvailable: false }), "PL"));

    // Clicking a grayed-out row used to swap the song and load a watch playlist.
    expect(player.currentSong).toBeNull();
    expect(PyBridge.getWatchPlaylist).not.toHaveBeenCalled();
  });

  it("starts an available track", () => {
    setup();

    act(() => player.playFromPlaylist(track(), "PL"));

    expect(player.currentSong?.videoId).toBe("v1");
  });
});
