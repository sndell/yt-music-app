import type { Track } from "@/lib/api";

export const PlaylistTrackList = ({ tracks }: { tracks: Track[] }) => {
  return (
    <div className="flex flex-col gap-3 p-6">
      {tracks.map((track) => (
        <PlaylistTrackItem key={track.videoId} track={track} />
      ))}
    </div>
  );
};

const PlaylistTrackItem = ({ track }: { track: Track }) => {
  return (
    <div className="grid grid-cols-3">
      <div className="flex gap-3 items-center">
        <div className="overflow-hidden w-10 h-10 rounded-sm shrink-0">
          {track.thumbnails[0].url ? (
            <img src={track.thumbnails[0].url} alt={track.title} className="object-cover" />
          ) : (
            <div className="grid place-items-center shrink-0 bg-primary-light">
              <span className="icon-[mingcute--music-2-line] text-primary-dark" />
            </div>
          )}
        </div>
        <div className="flex flex-col">
          <span>{track.title}</span>
          <span className="text-sm text-primary-dark">{track.artists.map((a) => a.name).join(", ")}</span>
        </div>
      </div>
    </div>
  );
};
