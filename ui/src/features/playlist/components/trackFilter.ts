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
 * keeps every appearance of a song that repeats, so they can be told apart, and
 * groups each song's copies together in the order the song is first seen.
 */
export const visibleTracks = (
  tracks: readonly Track[],
  { search, duplicatesOnly }: { search: string; duplicatesOnly: boolean },
): Track[] => {
  const needle = search.trim().toLowerCase();
  const duplicateIds = duplicatesOnly ? duplicateVideoIds(tracks) : null;
  const shown = tracks.filter((track) => {
    if (duplicateIds && !duplicateIds.has(track.videoId)) return false;
    if (!needle) return true;
    return (
      track.title.toLowerCase().includes(needle) ||
      track.artists.some((artist) => artist.name.toLowerCase().includes(needle)) ||
      (track.album?.name.toLowerCase().includes(needle) ?? false)
    );
  });
  if (!duplicatesOnly) return shown;
  // Group the copies of a song into one run: the song's first appearance sets the
  // run's place, and its copies keep their own order inside the run.
  const firstSeen = new Map<string, number>();
  tracks.forEach((track, index) => {
    if (!firstSeen.has(track.videoId)) firstSeen.set(track.videoId, index);
  });
  return shown
    .map((track, index) => ({ track, index }))
    .sort((a, b) => {
      const byFirstSeen = (firstSeen.get(a.track.videoId) ?? 0) - (firstSeen.get(b.track.videoId) ?? 0);
      return byFirstSeen || a.index - b.index;
    })
    .map(({ track }) => track);
};

/** How a collection list orders its rows. `playlist` keeps YouTube Music's own order. */
export type TrackSort = "playlist" | "added-desc" | "added-asc";

/**
 * Order the rows a collection list shows. Songs with an add time sort by it;
 * songs without one stay at the end in playlist order, in either direction.
 * `Array.prototype.sort` is stable, so equal keys keep their relative order.
 */
export const sortTracks = (tracks: readonly Track[], sort: TrackSort): Track[] => {
  if (sort === "playlist") return [...tracks];
  const direction = sort === "added-asc" ? 1 : -1;
  return [...tracks].sort((a, b) => {
    if (a.addedAt == null && b.addedAt == null) return 0;
    if (a.addedAt == null) return 1;
    if (b.addedAt == null) return -1;
    return (a.addedAt - b.addedAt) * direction;
  });
};

/** "19 Feb 2025" for a Unix-seconds add time, or null when it is unknown. */
export const formatAddedAt = (addedAt: number | null | undefined): string | null => {
  if (addedAt == null) return null;
  const date = new Date(addedAt * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};
