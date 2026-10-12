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

export interface QuickPick {
  videoId: string;
  title: string;
  artists: Artist[];
  album: Album | null;
  thumbnails: Thumbnail[];
  duration: string;
  durationSeconds: number;
  views?: string | null;
  isExplicit?: boolean;
  videoType?: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | null;
}

export interface QuickPicks {
  title: string;
  tracks: QuickPick[];
}

export type HomeItemKind = "song" | "playlist" | "album" | "artist";

export type HomeLayout = "list" | "row";

export interface HomeItem {
  kind: HomeItemKind;
  title: string;
  subtitle: string;
  artists: Artist[];
  thumbnails: Thumbnail[];
  videoId: string | null;
  playlistId: string | null;
  browseId: string | null;
  explicit: boolean;
}

export interface HomeShelf {
  title: string;
  layout: HomeLayout;
  items: HomeItem[];
}

export interface HomeFeed {
  shelves: HomeShelf[];
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

export interface AlbumVersion {
  title: string;
  year: string | null;
  browseId: string;
  thumbnails: Thumbnail[];
  explicit: boolean;
}

export interface AlbumDetails {
  browseId: string;
  title: string;
  type: string;
  description: string | null;
  artists: Artist[];
  year: string | null;
  trackCount: number;
  duration: string;
  durationSeconds: number;
  audioPlaylistId: string | null;
  thumbnails: Thumbnail[];
  dominantColor: string | null;
  tracks: Track[];
  otherVersions: AlbumVersion[];
}

export interface ArtistRelease {
  title: string;
  year: string | null;
  type: string;
  browseId: string;
  thumbnails: Thumbnail[];
  explicit: boolean;
}

export interface ArtistShelf<T> {
  browseId: string | null;
  params: string | null;
  items: T[];
}

export interface ArtistVideo {
  title: string;
  videoId: string;
  views: string | null;
  thumbnails: Thumbnail[];
  playlistId: string | null;
}

export interface RelatedArtist {
  title: string;
  browseId: string;
  subscribers: string | null;
  thumbnails: Thumbnail[];
}

export interface ArtistDetails {
  channelId: string;
  name: string;
  description: string | null;
  views: string | null;
  subscribers: string | null;
  monthlyListeners: string | null;
  thumbnails: Thumbnail[];
  dominantColor: string | null;
  shuffleId: string | null;
  radioId: string | null;
  songs: ArtistShelf<Track> | null;
  albums: ArtistShelf<ArtistRelease> | null;
  singles: ArtistShelf<ArtistRelease> | null;
  shows: ArtistShelf<ArtistRelease> | null;
  videos: ArtistShelf<ArtistVideo> | null;
  related: RelatedArtist[];
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

export interface DiscordPresenceStatus {
  enabled: boolean;
  clientId: string;
  connected: boolean;
  state: "off" | "connecting" | "connected" | "waiting" | "invalid" | "error";
  message: string;
  accepted: boolean;
}

export interface WatchPlaylist {
  tracks: WatchTrack[];
  playlistId: string | null;
  lyrics: string | null;
  related?: string | null;
}

/** API method signatures */
export interface ApiMethods {
  get_cover_color: { params: [imageUrl: string]; response: string | null };
  get_playlists: { params: []; response: PlaylistSummary[] };
  get_quick_picks: { params: []; response: QuickPicks };
  get_home: { params: []; response: HomeFeed };
  get_playlist_items: { params: [playlistId: string, forceRefresh?: boolean]; response: PlaylistDetails };
  move_playlist_item: {
    params: [playlistId: string, setVideoId: string, beforeSetVideoId: string];
    response: { status: string };
  };
  get_album: { params: [browseId: string]; response: AlbumDetails };
  get_artist: { params: [channelId: string]; response: ArtistDetails };
  get_artist_albums: { params: [channelId: string, params: string]; response: ArtistRelease[] };
  sign_in: { params: []; response: void };
  is_signed_in: { params: []; response: { signedIn: boolean } };
  sign_out: { params: []; response: void };
  invalidate_playlist_cache: { params: [playlistIds: string[]]; response: { invalidated: string[]; not_found: string[] } };
  clear_all_cache: { params: []; response: { cleared: number } };
  update_media_controls: {
    params: [title: string, artist: string, playing: boolean, hasNext: boolean, artwork: string];
    response: void;
  };
  get_discord_presence: { params: []; response: DiscordPresenceStatus };
  set_discord_presence: { params: [enabled: boolean, clientId: string]; response: DiscordPresenceStatus };
  update_discord_presence: {
    params: [
      title: string,
      artist: string,
      album: string,
      playing: boolean,
      elapsed: number,
      duration: number,
      artwork: string,
      videoId: string,
    ];
    response: void;
  };
    get_watch_playlist: {
    params: [videoId: string, playlistId: string, radio?: boolean, shuffle?: boolean];
    response: WatchPlaylist;
  };
  get_song_rating: { params: [videoId: string]; response: { likeStatus: LikeStatus } };
  rate_song: { params: [videoId: string, rating: LikeStatus]; response: { likeStatus: LikeStatus } };
  add_song_to_history: { params: [videoId: string]; response: { added: boolean } };
}

export type ApiMethodName = keyof ApiMethods;
export type ApiParams<M extends ApiMethodName> = ApiMethods[M]["params"];
export type ApiResponse<M extends ApiMethodName> = ApiMethods[M]["response"];
