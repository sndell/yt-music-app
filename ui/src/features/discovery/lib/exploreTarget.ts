import type { ExploreItem, Track } from "@/lib/api/types";

/** A playable row is a song or a video; everything else opens a page. */
export const isPlayableItem = (item: ExploreItem) => item.kind === "song" || item.kind === "video";

/**
 * The route an Explore item opens, or null when it plays instead.
 *
 * A release can arrive with an album browse id or with only its audio playlist
 * id, which `get_album` resolves, so both are an album route. Mirrors Home's
 * `albumOpenId`.
 */
export const exploreHref = (item: ExploreItem): string | null => {
  if (item.kind === "album") {
    if (item.browseId) return `/album/${item.browseId}`;
    if (item.playlistId?.startsWith("OLAK5uy_")) return `/album/${item.playlistId}`;
    return null;
  }
  if (item.kind === "playlist") return item.playlistId ? `/playlist/${item.playlistId}` : null;
  if (item.kind === "artist") return item.browseId ? `/artist/${item.browseId}` : null;
  return null;
};

/**
 * One Explore row as the player's track shape. The feed carries no per-row
 * duration or library state, and a chart row is never a saved song, so those
 * stay at their empty values; the like status is the player's to resolve.
 */
export const exploreTrack = (item: ExploreItem): Track => ({
  videoId: item.videoId ?? "",
  title: item.title,
  artists: item.artists,
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: item.thumbnails,
  isAvailable: Boolean(item.videoId),
  isExplicit: item.explicit,
  videoType: item.videoType ?? "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "",
  durationSeconds: 0,
  setVideoId: "",
});
