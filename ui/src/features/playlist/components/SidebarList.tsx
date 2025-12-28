import { useEffect } from "react";
import { useLocation } from "wouter";
import { usePlaylist } from "../hooks/usePlaylist";

export const SidebarList = () => {
  const { playlists, isLoading, error, fetchPlaylists } = usePlaylist();
  const [, navigate] = useLocation();

  useEffect(() => {
    fetchPlaylists();
  }, [fetchPlaylists]);

  return (
    <div className="flex overflow-y-auto flex-col gap-2 h-full scrollbar-thin p-1.5">
      <div className="flex flex-col flex-1 gap-1">
        {error && <div className="px-2 text-sm text-red-400">{error}</div>}

        {isLoading && (
          <div className="grid flex-1 place-items-center py-8">
            <span className="icon-[svg-spinners--ring-resize] text-2xl text-primary-dark" />
          </div>
        )}

        {playlists.length === 0 && !isLoading && !error && (
          <div className="grid place-content-center py-4 h-full text-sm text-center text-primary-dark">
            Playlists will be shown here. Add Auth Cookies in Settings.{" "}
            <button onClick={fetchPlaylists} className="cursor-pointer text-primary hover:underline">
              Reload
            </button>
          </div>
        )}

        {playlists.map((playlist) => {
          const thumbnailUrl = playlist.thumbnails?.[0]?.url;
          return (
            <button
              onClick={() => navigate(`/playlist/${playlist.playlistId}`)}
              key={playlist.playlistId}
              className="p-1.5 rounded-lg hover:bg-primary-light cursor-pointer text-sm text-primary-dark hover:text-primary transition-colors flex items-center gap-2"
            >
              {thumbnailUrl ? (
                <img src={thumbnailUrl} alt={playlist.title} className="w-10 h-10 rounded-sm shrink-0" />
              ) : (
                <div className="grid place-items-center w-10 h-10 rounded-sm shrink-0 bg-primary-light">
                  <span className="icon-[mingcute--music-2-line] text-primary-dark" />
                </div>
              )}
              <span className="truncate">{playlist.title}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
