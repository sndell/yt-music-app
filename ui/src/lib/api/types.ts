/**
 * Unified API Types
 * Single source of truth for the frontend-backend contract
 */

// ============================================================
// Result Pattern - Type-safe error handling
// ============================================================

export type Result<T, E = ApiError> =
  | { success: true; data: T }
  | { success: false; error: E };

export interface ApiError {
  code: string;
  message: string;
}

// ============================================================
// Shared Types
// ============================================================

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

// ============================================================
// Playlist Types
// ============================================================

export interface PlaylistSummary {
  title: string;
  playlistId: string;
  thumbnails: Thumbnail[];
  description: string;
  count?: string;
  author?: Author[];
}

export type LikeStatus = "LIKE" | "INDIFFERENT" | "DISLIKE";
export type VideoType = "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV";
export type PrivacyStatus = "UNLISTED" | "PUBLIC" | "PRIVATE";

export interface Track {
  videoId: string;
  title: string;
  artists: Artist[];
  album: Album | null;
  likeStatus: LikeStatus;
  inLibrary: boolean;
  pinnedToListenAgain: boolean;
  feedbackTokens: {
    add: string;
    remove: string;
  };
  listenAgainFeedbackTokens: {
    pin: string;
    unpin: string;
  };
  thumbnails: Thumbnail[];
  isAvailable: boolean;
  isExplicit: boolean;
  videoType: VideoType;
  views: number | null;
  duration: string;
  duration_seconds: number;
  setVideoId: string;
}

export interface PlaylistDetails {
  owned: boolean;
  id: string;
  privacy: PrivacyStatus;
  description: string | null;
  views: number;
  duration: string;
  trackCount: number;
  title: string;
  thumbnails: Thumbnail[];
  author: Author;
  year: string;
  related: unknown[];
  tracks: Track[];
  duration_seconds: number;
  /** Hex color string of the dominant vibrant color from the playlist thumbnail (e.g., "#ff5733") */
  dominantColor: string | null;
}

// ============================================================
// API Method Registry - Maps method names to request/response types
// ============================================================

/**
 * Define all API methods and their signatures here.
 * This creates a type-safe contract between frontend and backend.
 */
export interface ApiMethods {
  get_playlists: {
    params: [];
    response: PlaylistSummary[];
  };
  get_playlist_items: {
    params: [playlistId: string];
    response: PlaylistDetails;
  };
  generate_auth_header: {
    params: [headers: string];
    response: void;
  };
}

/** All available API method names */
export type ApiMethodName = keyof ApiMethods;

/** Extract params type for a method */
export type ApiParams<M extends ApiMethodName> = ApiMethods[M]["params"];

/** Extract response type for a method */
export type ApiResponse<M extends ApiMethodName> = ApiMethods[M]["response"];
