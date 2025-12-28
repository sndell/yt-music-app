/** API Types - Frontend-backend contract */

export type Result<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } };

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
  likeStatus: "LIKE" | "INDIFFERENT" | "DISLIKE";
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

/** API method signatures */
export interface ApiMethods {
  get_playlists: { params: []; response: PlaylistSummary[] };
  get_playlist_items: { params: [playlistId: string, forceRefresh?: boolean]; response: PlaylistDetails };
  generate_auth_header: { params: [headers: string]; response: void };
  invalidate_playlist_cache: { params: [playlistIds: string[]]; response: { invalidated: string[]; not_found: string[] } };
  clear_all_cache: { params: []; response: { cleared: number } };
}

export type ApiMethodName = keyof ApiMethods;
export type ApiParams<M extends ApiMethodName> = ApiMethods[M]["params"];
export type ApiResponse<M extends ApiMethodName> = ApiMethods[M]["response"];
