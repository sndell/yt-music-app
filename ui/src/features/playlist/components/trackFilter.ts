import type { Track } from "@/lib/api";

/** videoIds that appear more than once in a list, the songs "Find duplicates" shows. */
export const duplicateVideoIds = (tracks: readonly Track[]): Set<string> => {
  const counts = new Map<string, number>();
  for (const track of tracks) counts.set(track.videoId, (counts.get(track.videoId) ?? 0) + 1);
  const ids = new Set<string>();
  for (const [videoId, count] of counts) if (count > 1) ids.add(videoId);
  return ids;
};

/**
 * The rows a collection list should show. `search` matches the song, its artists
 * and the album, like the in-playlist search on YouTube Music. `duplicatesOnly`
 * keeps every appearance of a song that repeats, so they can be told apart.
 */
export const visibleTracks = (
  tracks: readonly Track[],
  { search, duplicatesOnly }: { search: string; duplicatesOnly: boolean },
): Track[] => {
  const needle = search.trim().toLowerCase();
  const duplicateIds = duplicatesOnly ? duplicateVideoIds(tracks) : null;
  return tracks.filter((track) => {
    if (duplicateIds && !duplicateIds.has(track.videoId)) return false;
    if (!needle) return true;
    return (
      track.title.toLowerCase().includes(needle) ||
      track.artists.some((artist) => artist.name.toLowerCase().includes(needle)) ||
      (track.album?.name.toLowerCase().includes(needle) ?? false)
    );
  });
};
