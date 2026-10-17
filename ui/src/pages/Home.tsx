import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PyBridge, showCachedThenRefresh, type HomeFeed, type HomeItem, type HomeShelf, type Track } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { HomeRow } from "./home/HomeShelf";
import { QuickPicks } from "./home/QuickPicks";
import { albumOpenId } from "./home/homeItem";

const toTrack = (item: HomeItem): Track => ({
  videoId: item.videoId ?? "",
  title: item.title,
  artists: item.artists ?? [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: item.thumbnails ?? [],
  isAvailable: true,
  isExplicit: item.explicit,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "",
  durationSeconds: 0,
  setVideoId: "",
});

export const Home = () => {
  const [shelves, setShelves] = useState<HomeShelf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [menu, setMenu] = useState<
    { kind: "track"; track: Track; x: number; y: number } | { kind: "playlist"; playlistId: string; x: number; y: number } | null
  >(null);
  const isMenuTarget = (item: HomeItem) =>
    menu?.kind === "track"
      ? menu.track.videoId === item.videoId
      : menu?.kind === "playlist"
        ? menu.playlistId === item.playlistId
        : false;
  const requestIdRef = useRef(0);
  const [, navigate] = useLocation();
  const { currentSong, startMix, playTracks, playTrackNext, addTrackToQueue, playPlaylist, queuePlaylist, trueShufflePlaylist } = usePlayer();
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } = usePlaylist();
  const [newPlaylistFor, setNewPlaylistFor] = useState<string[] | null>(null);

  const load = useCallback((options?: { clear?: boolean; force?: boolean }) => {
    const requestId = ++requestIdRef.current;
    if (options?.clear) {
      setShelves(null);
      setPage(0);
    }
    setError(null);

    const apply = (data: HomeFeed) => {
      if (!Array.isArray(data.shelves)) return;
      setShelves((current) => {
        if (data.shelves.length === 0 && current && current.length > 0) return current;
        return data.shelves;
      });
      setError(null);
    };

    if (options?.force) {
      return PyBridge.getHome(true).then((result) => {
        if (requestId !== requestIdRef.current) return;
        if (result.success) {
          apply(result.data);
          return;
        }
        setShelves([]);
        setError(result.error.message);
      });
    }

    return showCachedThenRefresh(
      (forceRefresh) => PyBridge.getHome(forceRefresh),
      apply,
      () => requestId === requestIdRef.current,
    ).then((result) => {
      if (requestId !== requestIdRef.current || !result || result.success) return;
      setShelves([]);
      setError(result.error.message);
    });
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load({ clear: true, force: true });
    window.addEventListener("ytmusic-auth-changed", refresh);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("ytmusic-auth-changed", refresh);
    };
  }, [load]);

  const openItem = (item: HomeItem) => {
    if (item.kind === "song" && item.videoId) {
      startMix(toTrack(item));
      return;
    }
    if (item.kind === "artist" && item.browseId) {
      navigate(`/artist/${item.browseId}`);
      return;
    }
    const albumId = albumOpenId(item);
    if (albumId) {
      navigate(`/album/${albumId}`);
      return;
    }
    if (item.kind === "playlist" && item.playlistId) navigate(`/playlist/${item.playlistId}`);
  };

  const playAlbum = (item: HomeItem) => {
    const id = albumOpenId(item);
    if (!id) return;
    void PyBridge.getAlbum(id).then((result) => {
      if (!result.success) return;
      const audioPlaylistId = result.data.audioPlaylistId;
      if (!audioPlaylistId) return;
      void playPlaylist(audioPlaylistId, "play");
    });
  };

  const hasContent = shelves !== null && shelves.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto p-4 sm:p-6">
        {error && <div className="mb-3 text-sm text-red-400">{error}</div>}

        {shelves === null && (
          <div className="grid place-items-center py-8" role="status">
            <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
          </div>
        )}

        {shelves !== null && shelves.length === 0 && !error && (
          <div className="py-8 text-sm text-primary-dark">
            Sign in from Settings.{" "}
            <button type="button" onClick={() => void load({ force: true })} className="cursor-pointer text-primary hover:underline">
              Reload
            </button>
          </div>
        )}

        {hasContent && (
          <div className="flex flex-col gap-6">
            {shelves.map((shelf) =>
              shelf.layout === "row" ? (
                <HomeRow
                  key={shelf.title}
                  shelf={shelf}
                  currentVideoId={currentSong?.videoId}
                  isMenuTarget={isMenuTarget}
                  onOpen={openItem}
                  onPlayAlbum={playAlbum}
                  onPlayPlaylist={(playlistId) => void playPlaylist(playlistId, "play")}
                  onOpenMenu={(item, x, y) => {
                    if (item.kind === "playlist" && item.playlistId) {
                      setMenu({ kind: "playlist", playlistId: item.playlistId, x, y });
                      return;
                    }
                    if (!item.videoId) return;
                    setMenu({ kind: "track", track: toTrack(item), x, y });
                  }}
                />
              ) : (
                <QuickPicks
                  key={shelf.title}
                  shelf={shelf}
                  page={page}
                  setPage={setPage}
                  currentVideoId={currentSong?.videoId}
                  isMenuTarget={isMenuTarget}
                  onPlayAll={() => playTracks(shelf.items.filter((item) => item.videoId).map(toTrack))}
                  onOpen={openItem}
                  onOpenMenu={(item, x, y) => {
                    if (!item.videoId) return;
                    setMenu({ kind: "track", track: toTrack(item), x, y });
                  }}
                />
              )
            )}
          </div>
        )}
      </div>
      {menu?.kind === "track" && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
          addToPlaylistVideoIds={[menu.track.videoId]}
          playlists={playlists}
          recommendedPlaylists={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onLoadRecommendations={() => void fetchRecommendedPlaylists()}
          onNewPlaylist={() => setNewPlaylistFor([menu.track.videoId])}
        />
      )}
      {menu?.kind === "playlist" && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onShuffle={() => void playPlaylist(menu.playlistId, "shuffle")}
          onTrueShuffle={() => void trueShufflePlaylist(menu.playlistId)}
          onStartMix={() => void playPlaylist(menu.playlistId, "mix")}
          onPlayNext={() => void queuePlaylist(menu.playlistId, "next")}
          onAddToQueue={() => void queuePlaylist(menu.playlistId, "end")}
        />
      )}
      {newPlaylistFor && (
        <CreatePlaylistDialog
          onCancel={() => setNewPlaylistFor(null)}
          onSubmit={async (title, description, privacy) => {
            const playlistId = await createPlaylist(title, description, privacy, newPlaylistFor);
            if (playlistId) setNewPlaylistFor(null);
            return playlistId;
          }}
        />
      )}
    </div>
  );
};
