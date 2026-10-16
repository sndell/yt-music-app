/** Video types YouTube Music uses for a track that has a video rendition. */
const VIDEO_TYPES = new Set(["MUSIC_VIDEO_TYPE_OMV", "MUSIC_VIDEO_TYPE_UGC"]);

/**
 * A music video renders in a 16:9 frame; an audio track keeps square art. The
 * frame shape tells the two apart in a list that holds both.
 */
export const isVideoMedia = (videoType?: string | null) => VIDEO_TYPES.has(videoType ?? "");
