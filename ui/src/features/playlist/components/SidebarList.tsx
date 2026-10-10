import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import type { PlaylistSummary } from "@/lib/api";
import { usePlaylist } from "../hooks/usePlaylist.tsx";

export const SidebarList = () => {
  const { playlists, isLoading, error, fetchPlaylists } = usePlaylist();
  const [, navigate] = useLocation();

  useEffect(() => {
    fetchPlaylists();
    const onAuthChanged = () => fetchPlaylists();
    window.addEventListener("ytmusic-auth-changed", onAuthChanged);
    return () => window.removeEventListener("ytmusic-auth-changed", onAuthChanged);
  }, [fetchPlaylists]);

  return (
    <div className="flex overflow-y-auto flex-col gap-2 h-full scrollbar-thin p-1.5">
      <div className="flex flex-col flex-1 gap-1">
        {error && <div className="px-2 text-sm text-red-400">{error}</div>}

        {isLoading && (
          <div className="grid flex-1 place-items-center py-8">
            <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
          </div>
        )}

        {playlists.length === 0 && !isLoading && !error && (
          <div className="grid place-content-center py-4 h-full text-sm text-center text-primary-dark">
            Playlists will be shown here. Sign in from Settings.{" "}
            <button onClick={fetchPlaylists} className="cursor-pointer text-primary hover:underline">
              Reload
            </button>
          </div>
        )}

        {playlists.map((playlist) => (
          <PlaylistSidebarItem
            key={playlist.playlistId}
            playlist={playlist}
            onOpen={() => navigate(`/playlist/${playlist.playlistId}`)}
          />
        ))}
      </div>
    </div>
  );
};

const songCountLabel = (count: string | null | undefined): string | null => {
  if (count == null) return null;
  const digits = count.replace(/,/g, "").trim();
  if (digits === "") return null;
  const total = Number(digits);
  if (!Number.isInteger(total) || total < 0) return null;
  return total === 1 ? "1 song" : `${total} songs`;
};

const PlaylistSidebarItem = ({ playlist, onOpen }: { playlist: PlaylistSummary; onOpen: () => void }) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = playlist.thumbnails?.[0]?.url;
  const countLabel = songCountLabel(playlist.count);

  return (
    <button
      onClick={onOpen}
      className="p-1.5 rounded-lg hover:bg-primary-light cursor-pointer text-sm text-primary-dark hover:text-primary transition-colors flex items-center gap-2 w-full min-w-0 text-left"
    >
      {thumbnailUrl && !failed ? (
        <img
          src={thumbnailUrl}
          alt=""
          onError={() => setFailed(true)}
          className="object-cover w-10 h-10 rounded-sm shrink-0"
        />
      ) : (
        <div className="grid place-items-center w-10 h-10 rounded-sm shrink-0 bg-primary-light">
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        </div>
      )}
      <span className="flex flex-col flex-1 min-w-0">
        <span className="truncate">{playlist.title}</span>
        {countLabel && <span className="text-xs truncate text-primary-dark">{countLabel}</span>}
      </span>
    </button>
  );
};
