import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { PyBridge } from "@/lib/api/bridge";
import { ToastProvider } from "@/components/ui/Toast";
import type { LibraryAlbum } from "@/lib/api/types";
import { useAlbumLibrary } from "./useAlbumLibrary";

vi.mock("@/lib/api/bridge", () => ({
  PyBridge: {
    getLibraryAlbums: vi.fn(),
    ratePlaylist: vi.fn(),
  },
}));

const savedAlbum: LibraryAlbum = {
  browseId: "MPREb_9Asizcbpvcp",
  playlistId: "OLAK5uy_library",
  title: "BEACH ROCK HOTEL",
  type: "Album",
  thumbnails: [],
  artists: [],
  year: "2024",
};

const album = { browseId: "MPREb_9Asizcbpvcp", audioPlaylistId: "OLAK5uy_library" };

let context: ReturnType<typeof useAlbumLibrary>;

const Probe = () => {
  context = useAlbumLibrary();
  return null;
};

const setup = () =>
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>,
  );

const settle = () => act(async () => {});

describe("useAlbumLibrary", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports an album in the library as saved", async () => {
    (PyBridge.getLibraryAlbums as Mock).mockResolvedValue({ success: true, data: [savedAlbum] });
    setup();

    // Before the library fetch lands nothing is known to be saved.
    expect(context.isSaved(album)).toBe(false);

    await settle();

    expect(context.isSaved(album)).toBe(true);
  });

  it("removes an already saved album through rate_playlist", async () => {
    (PyBridge.getLibraryAlbums as Mock).mockResolvedValue({ success: true, data: [savedAlbum] });
    (PyBridge.ratePlaylist as Mock).mockResolvedValue({ success: true, data: { status: "OK" } });
    setup();

    await settle();
    expect(context.isSaved(album)).toBe(true);

    await act(async () => {
      await context.rateAlbum(album, false);
    });

    expect(PyBridge.ratePlaylist).toHaveBeenCalledWith("OLAK5uy_library", "INDIFFERENT");
    expect(context.isSaved(album)).toBe(false);
  });

  it("saves an album that is not yet in the library", async () => {
    (PyBridge.getLibraryAlbums as Mock).mockResolvedValue({ success: true, data: [] });
    (PyBridge.ratePlaylist as Mock).mockResolvedValue({ success: true, data: { status: "OK" } });
    setup();

    await settle();
    expect(context.isSaved(album)).toBe(false);

    await act(async () => {
      await context.rateAlbum(album, true);
    });

    expect(PyBridge.ratePlaylist).toHaveBeenCalledWith("OLAK5uy_library", "LIKE");
    expect(context.isSaved(album)).toBe(true);
  });
});
