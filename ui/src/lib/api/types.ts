/** API Types - Frontend-backend contract */

export type Result<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } };

export type LikeStatus = "LIKE" | "DISLIKE" | "INDIFFERENT";

export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

export interface Author {
  name: string;
  id: string;
}

export interface Artist {
  name: string;
  id: string;
}

export interface Album {
  name: string;
  id: string;
}

export interface PlaylistSummary {
  title: string;
  playlistId: string;
  thumbnails: Thumbnail[];
  description: string;
  count?: string;
  author?: Author[];
}

export interface Track {
  videoId: string;
  title: string;
  artists: Artist[];
  album: Album | null;
  likeStatus: LikeStatus;
  
  inLibrary: boolean;
  thumbnails: Thumbnail[];
  isAvailable: boolean;
  isExplicit: boolean;
  videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV";
  views: number | null;
  duration: string;
  durationSeconds: number;
  setVideoId: string;
}

export interface PlaylistDetails {
  owned: boolean;
  id: string;
  privacy: "UNLISTED" | "PUBLIC" | "PRIVATE";
  description: string | null;
  views: number;
  duration: string;
  trackCount: number;
  title: string;
  thumbnails: Thumbnail[];
  author: Author;
  year: string;
  tracks: Track[];
  durationSeconds: number;
  dominantColor: string | null;
}

export interface FeedbackTokens {
  add: string;
  remove: string;
}

export interface ListenAgainFeedbackTokens {
  pin: string;
  unpin: string;
}

export interface WatchArtist {
  name: string;
  id: string | null;
}

export interface WatchCounterpart {
  videoId: string;
  title: string;
  length: string;
  thumbnail: Thumbnail[];
  feedbackTokens: FeedbackTokens | null;
  likeStatus: LikeStatus;
  artists: WatchArtist[];
  views: string;
}

export interface WatchTrack {
  videoId: string;
  title: string;
  length: string | null;
  thumbnail: Thumbnail[] | null;
  likeStatus: LikeStatus | null;
  videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | null;
  inLibrary: boolean | null;
  feedbackTokens: FeedbackTokens | null;
  pinnedToListenAgain: boolean | null;
  listenAgainFeedbackTokens: ListenAgainFeedbackTokens | null;
  artists?: WatchArtist[];
  album?: Album | null;
  year?: string | null;
  counterpart?: WatchCounterpart;
}

export interface WatchPlaylist {
  tracks: WatchTrack[];
  playlistId: string | null;
  lyrics: string | null;
  related?: string | null;
}

/** API method signatures */
export interface ApiMethods {
  get_playlists: { params: []; response: PlaylistSummary[] };
  get_playlist_items: { params: [playlistId: string, forceRefresh?: boolean]; response: PlaylistDetails };
  sign_in: { params: []; response: void };
  is_signed_in: { params: []; response: { signedIn: boolean } };
  sign_out: { params: []; response: void };
  invalidate_playlist_cache: { params: [playlistIds: string[]]; response: { invalidated: string[]; not_found: string[] } };
  clear_all_cache: { params: []; response: { cleared: number } };
  update_media_controls: {
    params: [title: string, artist: string, playing: boolean, hasNext: boolean, artwork: string];
    response: void;
  };
    get_watch_playlist: {
    params: [videoId: string, playlistId: string, radio?: boolean, shuffle?: boolean];
    response: WatchPlaylist;
  };
  get_song_rating: { params: [videoId: string]; response: { likeStatus: LikeStatus } };
  rate_song: { params: [videoId: string, rating: LikeStatus]; response: { likeStatus: LikeStatus } };
}

export type ApiMethodName = keyof ApiMethods;
export type ApiParams<M extends ApiMethodName> = ApiMethods[M]["params"];
export type ApiResponse<M extends ApiMethodName> = ApiMethods[M]["response"];
