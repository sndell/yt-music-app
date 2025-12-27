import { usePlaylist } from "../hooks/usePlaylist";

export const SidebarList = () => {
  const { playlists, isLoading, error, fetchPlaylists } = usePlaylist();

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={fetchPlaylists}
        disabled={isLoading}
        className="bg-primary-light py-1.5 w-full rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? "Loading..." : "Get playlists"}
      </button>

      <div className="flex flex-col gap-1">
        {error && <div className="px-2 text-sm text-red-400">{error}</div>}

        {playlists.length === 0 && !isLoading && !error && (
          <div className="grid place-items-center py-4 h-full text-sm text-center text-primary-dark">
            Playlists will be shown here. Add Auth Cookies in Settings.
          </div>
        )}

        {playlists.map((playlist, idx) => (
          <div
            key={idx}
            className="px-2 py-1.5 rounded-lg hover:bg-primary-light cursor-pointer text-sm text-primary-dark hover:text-primary transition-colors"
          >
            {playlist}
          </div>
        ))}
      </div>
    </div>
  );
};
