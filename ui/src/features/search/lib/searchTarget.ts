import type { SearchResult, Track } from "@/lib/api";

/** Where a non-playable result opens, or null when it has no page of its own. */
export const searchHref = (result: SearchResult): string | null => {
  if (result.kind === "album") return result.browseId ? `/album/${result.browseId}` : null;
  if (result.kind === "artist" || result.kind === "profile") {
    return result.browseId ? `/artist/${result.browseId}` : null;
  }
  if (result.kind === "playlist") return result.playlistId ? `/playlist/${result.playlistId}` : null;
  return null;
};

export const isPlayable = (result: SearchResult) =>
  Boolean(result.videoId) && (result.kind === "song" || result.kind === "video");

/** A search row already carries most of a Track; this fills in the rest. */
export const searchResultToTrack = (result: SearchResult): Track => ({
  videoId: result.videoId ?? "",
  title: result.title,
  artists: result.artists,
  album: result.album,
  likeStatus: "INDIFFERENT",
  inLibrary: result.inLibrary,
  thumbnails: result.thumbnails,
  isAvailable: true,
  isExplicit: result.explicit,
  videoType: result.videoType,
  views: null,
  duration: result.duration,
  durationSeconds: result.durationSeconds,
  setVideoId: "",
});
