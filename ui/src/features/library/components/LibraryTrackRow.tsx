import type { Track } from "@/lib/api";
import { TrackRow } from "@/components/ui/TrackRow";

/**
 * One compact library song row. The Songs view renders the full list
 * virtualized; this is the short preview the All view shows, so it stays a
 * plain button instead of a track-list row.
 */
export const LibraryTrackRow = ({
  track,
  playing = false,
  onPlay,
}: {
  track: Track;
  playing?: boolean;
  onPlay: () => void;
}) => {
  const available = track.isAvailable && Boolean(track.videoId);
  const subtitle = track.artists.map((artist) => artist.name).join(", ");

  return (
    <TrackRow
      title={track.title}
      subtitle={subtitle}
      thumbnails={track.thumbnails}
      explicit={track.isExplicit}
      trailing={
        track.duration ? (
          <span className="shrink-0 text-xs text-primary-dark tabular-nums">{track.duration}</span>
        ) : null
      }
      playing={playing}
      disabled={!available}
      reveal={available}
      onActivate={onPlay}
    />
  );
};
