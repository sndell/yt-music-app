import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { PyBridge } from "@/lib/api/bridge";
import { ToastProvider } from "@/components/ui/Toast";
import type { PlaylistSummary } from "@/lib/api/types";
import { PlaylistProvider } from "@/features/playlist/hooks/usePlaylist";
import { AddToPlaylistPanel } from "./AddToPlaylistPanel";

vi.mock("@/lib/api/bridge", () => ({
  PyBridge: {
    getPlaylists: vi.fn(),
    addPlaylistItems: vi.fn(),
    removePlaylistVideos: vi.fn(),
  },
}));

const playlist: PlaylistSummary = {
  playlistId: "PL",
  title: "Road trip",
  description: "",
  thumbnails: [],
  count: "2",
  owned: true,
};

const setup = () =>
  render(
    <ToastProvider>
      <PlaylistProvider>
        <AddToPlaylistPanel videoIds={["v1"]} playlists={[playlist]} recommended={null} />
      </PlaylistProvider>
    </ToastProvider>,
  );

const row = () => screen.getByRole("button", { name: /Road trip/ });
const spinners = () => document.querySelectorAll(".animate-spin").length;

describe("AddToPlaylistPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows a spinner while the add is queued or running", async () => {
    let resolveAdd: (value: unknown) => void = () => {};
    (PyBridge.addPlaylistItems as Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveAdd = resolve;
      }),
    );
    setup();

    fireEvent.click(row());
    expect(spinners()).toBe(1);

    await act(async () => {
      resolveAdd({ success: true, data: { status: "STATUS_SUCCEEDED", setVideoIds: { v1: "sv1" }, duplicate: false } });
    });
    expect(spinners()).toBe(0);
  });

  it("adds on the first click and removes on the second", async () => {
    (PyBridge.addPlaylistItems as Mock).mockResolvedValue({
      success: true,
      data: { status: "STATUS_SUCCEEDED", setVideoIds: { v1: "sv1" }, duplicate: false },
    });
    (PyBridge.removePlaylistVideos as Mock).mockResolvedValue({
      success: true,
      data: { status: "STATUS_SUCCEEDED", removed: 1 },
    });
    setup();

    fireEvent.click(row());
    await waitFor(() => expect(PyBridge.addPlaylistItems).toHaveBeenCalledWith("PL", ["v1"], false));

    fireEvent.click(row());
    await waitFor(() =>
      expect(PyBridge.removePlaylistVideos).toHaveBeenCalledWith("PL", ["v1"], { v1: "sv1" }),
    );
  });

  it("confirms a pick that was already there, then removes on the next click", async () => {
    (PyBridge.addPlaylistItems as Mock).mockResolvedValue({
      success: true,
      data: { status: "DUPLICATE", setVideoIds: {}, duplicate: true },
    });
    (PyBridge.removePlaylistVideos as Mock).mockResolvedValue({
      success: true,
      data: { status: "STATUS_SUCCEEDED", removed: 1 },
    });
    setup();

    fireEvent.click(row());
    await waitFor(() => expect(screen.getByText("Already in that playlist")).toBeTruthy());

    fireEvent.click(row());
    await waitFor(() =>
      expect(PyBridge.removePlaylistVideos).toHaveBeenCalledWith("PL", ["v1"], {}),
    );
  });

  it("adds the song anyway from the duplicate toast", async () => {
    (PyBridge.addPlaylistItems as Mock)
      .mockResolvedValueOnce({
        success: true,
        data: { status: "DUPLICATE", setVideoIds: {}, duplicate: true },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { status: "STATUS_SUCCEEDED", setVideoIds: { v1: "sv1" }, duplicate: false },
      });
    setup();

    fireEvent.click(row());
    fireEvent.click(await screen.findByText("Add anyway"));

    await waitFor(() =>
      expect(PyBridge.addPlaylistItems).toHaveBeenLastCalledWith("PL", ["v1"], true),
    );
  });
});
