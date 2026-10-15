import type { WatchTrack } from "@/lib/api";

/**
 * The YouTube id to embed for a track, or null when the track has no music
 * video.
 *
 * A queue row is a music video when it is one itself (a video result, or an
 * artist video), or when the watch playlist attaches a music-video counterpart
 * — the OMV rendition of an audio track. User uploads and plain audio tracks
 * return null, so the player only opens on real music videos.
 */
export const musicVideoId = (track: WatchTrack | null | undefined): string | null => {
  if (!track) return null;
  if (track.videoType === "MUSIC_VIDEO_TYPE_OMV" && track.videoId) return track.videoId;
  const counterpart = track.counterpart;
  if (counterpart?.videoType === "MUSIC_VIDEO_TYPE_OMV" && counterpart.videoId) return counterpart.videoId;
  return null;
};
