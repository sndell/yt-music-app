import { BrowseCard } from "@/components/ui/BrowseCard";
import type { PlaylistSummary } from "@/lib/api/types";

/**
 * Playlist cards in a wrapping grid, the same card the Library page draws.
 *
 * A category can hold a few hundred playlists and carries no count per row
 * (YouTube sends no count for its own lists), so the card shows the title and
 * its cover and nothing else. Covers stay remote until one fails to decode,
 * which is the card's own inline-thumbnail fallback.
 */
export const PlaylistGrid = ({ playlists }: { playlists: PlaylistSummary[] }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-5">
    {playlists.map((playlist) => (
      <BrowseCard
        key={playlist.playlistId}
        href={`/playlist/${playlist.playlistId}`}
        title={playlist.title}
        subtitle={playlist.count ? songCountLabel(playlist.count) : null}
        thumbnails={playlist.thumbnails}
      />
    ))}
  </div>
);

/** "47" -> "47 songs". Anything that is not a count is left off the card. */
const songCountLabel = (count: string) => {
  const total = Number(count.replace(/,/g, "").trim());
  if (!Number.isInteger(total) || total < 0) return null;
  return total === 1 ? "1 song" : `${total} songs`;
};
