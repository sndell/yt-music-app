import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PyBridge } from "@/lib/api/bridge";
import type { Track } from "@/lib/api/types";
import { PlayerProvider, usePlayer } from "../context/PlayerContext";
import { Player } from "./Player";

vi.mock("@/lib/api/bridge", () => ({
  PyBridge: {
    getAudioStream: vi.fn(),
    getVolume: vi.fn(),
    setVolume: vi.fn(),
    updateMediaControls: vi.fn(),
    updateDiscordPresence: vi.fn(),
    addSongToHistory: vi.fn(),
    getSongRating: vi.fn(),
    getQueueTuner: vi.fn(),
  },
}));

const message = (data: unknown) => ({ success: true, data });

const track: Track = {
  videoId: "v1",
  title: "Song",
  artists: [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: [{ url: "thumb.jpg", width: 60, height: 60 }],
  isAvailable: true,
  isExplicit: false,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "3:00",
  durationSeconds: 180,
  setVideoId: "s1",
};

let player: ReturnType<typeof usePlayer>;

const Probe = () => {
  player = usePlayer();
  return null;
};

const transport = (name: "Play" | "Pause") => screen.queryByRole("button", { name });

describe("Player play state", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    (PyBridge.getAudioStream as Mock).mockResolvedValue(message({ url: "blob:test" }));
    (PyBridge.getVolume as Mock).mockResolvedValue(message(50));
    (PyBridge.setVolume as Mock).mockResolvedValue(message(null));
    (PyBridge.updateMediaControls as Mock).mockResolvedValue(message(null));
    (PyBridge.updateDiscordPresence as Mock).mockResolvedValue(message(null));
    (PyBridge.addSongToHistory as Mock).mockResolvedValue(message(null));
    (PyBridge.getSongRating as Mock).mockResolvedValue(message({ likeStatus: "INDIFFERENT" }));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows playing again when the embed resumes the audio", async () => {
    render(
      <PlayerProvider>
        <Probe />
        <Player />
      </PlayerProvider>,
    );

    await act(async () => {
      player.setCurrentSong(track);
    });

    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(transport("Pause")).not.toBeNull();

    // The embed pauses the audio on its own, then resumes it.
    await act(async () => {
      audio?.dispatchEvent(new Event("pause"));
    });
    expect(transport("Play")).not.toBeNull();

    await act(async () => {
      audio?.dispatchEvent(new Event("play"));
    });
    expect(transport("Pause")).not.toBeNull();
  });
});
