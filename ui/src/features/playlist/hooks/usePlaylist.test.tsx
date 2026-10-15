import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { PyBridge } from "@/lib/api/bridge";
import { ToastProvider } from "@/components/ui/Toast";
import type { PlaylistSummary } from "@/lib/api/types";
import { PlaylistProvider, usePlaylist } from "./usePlaylist";

vi.mock("@/lib/api/bridge", () => ({
  PyBridge: {
    getPlaylists: vi.fn(),
    createPlaylist: vi.fn(),
  },
}));

const likedMusic: PlaylistSummary = {
  playlistId: "LM",
  title: "Liked Music",
  description: "",
  thumbnails: [],
  count: "3",
  owned: true,
};

const newPlaylist: PlaylistSummary = {
  playlistId: "NEW",
  title: "My new playlist",
  description: "",
  thumbnails: [],
  count: "1",
  owned: true,
};

let context: ReturnType<typeof usePlaylist>;

const Probe = () => {
  context = usePlaylist();
  return null;
};

const setup = () =>
  render(
    <ToastProvider>
      <PlaylistProvider>
        <Probe />
      </PlaylistProvider>
    </ToastProvider>,
  );

const ids = () => context.playlists.map((playlist) => playlist.playlistId);

describe("usePlaylist.createPlaylist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (PyBridge.createPlaylist as Mock).mockResolvedValue({
      success: true,
      data: { playlistId: "NEW" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps a just-created playlist visible while the library fetch is still stale", async () => {
    // The library endpoint lags a new playlist; it does not list NEW yet.
    (PyBridge.getPlaylists as Mock).mockResolvedValue({ success: true, data: [likedMusic] });
    setup();

    await act(async () => {
      await context.fetchPlaylists();
    });
    expect(ids()).toEqual(["LM"]);

    await act(async () => {
      await context.createPlaylist("My new playlist", "", "PRIVATE", ["v1"]);
    });

    // Before the fix the stale fetch wiped the optimistic row.
    expect(ids()).toContain("NEW");
  });

  it("drops the placeholder, without duplicating it, once the library reports the playlist", async () => {
    (PyBridge.getPlaylists as Mock).mockResolvedValue({
      success: true,
      data: [likedMusic, newPlaylist],
    });
    setup();

    await act(async () => {
      await context.createPlaylist("My new playlist", "", "PRIVATE", ["v1"]);
    });
    await act(async () => {
      await context.fetchPlaylists();
    });

    expect(ids().filter((id) => id === "NEW")).toHaveLength(1);
  });
});
