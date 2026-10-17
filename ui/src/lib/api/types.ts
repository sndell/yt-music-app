/** API Types - Frontend-backend contract */

export type Result<T> = { success: true; data: T } | { success: false; error: { code: string; message: string } };

export type LikeStatus = "LIKE" | "DISLIKE" | "INDIFFERENT";

export type PlaylistPrivacy = "UNLISTED" | "PUBLIC" | "PRIVATE";

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

export type PlaylistSummary = {
  title: string;
  playlistId: string;
  thumbnails: Thumbnail[];
  description: string;
  count?: string;
  author?: Author[];
  /** Present on library playlists. False means the user cannot edit it. */
  owned?: boolean;
};

/** One row in an owned playlist, addressed by its playlist-specific id. */
export interface PlaylistItemRef {
  videoId: string;
  setVideoId: string;
}

/** Fields the playlist edit dialog may change at once. Untouched ones are omitted. */
export interface PlaylistPatch {
  title?: string;
  description?: string;
  privacy?: PlaylistPrivacy;
}

export interface LibraryAlbum {
  browseId: string;
  playlistId: string | null;
  title: string;
  type: string;
  thumbnails: Thumbnail[];
  artists: Artist[];
  year: string | null;
}

export interface LibraryArtist {
  browseId: string;
  name: string;
  /**
   * Songs this artist has in the library. ytmusicapi exposes it under
   * "subscribers", but for a library artist that is this count, not the
   * channel's subscriber total.
   */
  songCount: number;
  thumbnails: Thumbnail[];
}

/** Saved library lists. Cached whole in Python, so each paints from disk. */
export interface LibrarySongs {
  songs: Track[];
  fromCache?: boolean;
}

export interface LibraryAlbums {
  albums: LibraryAlbum[];
  fromCache?: boolean;
}

export interface LibraryArtists {
  artists: LibraryArtist[];
  fromCache?: boolean;
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
  /** Set on song items only, so the UI can mark a video rendition with a 16:9 frame. */
  videoType?: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC" | null;
}

export interface HomeShelf {
  title: string;
  layout: HomeLayout;
  items: HomeItem[];
}

export interface HomeFeed {
  shelves: HomeShelf[];
  fromCache?: boolean;
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
  videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC";
  views: number | null;
  duration: string;
  durationSeconds: number;
  setVideoId: string;
  /**
   * Unix seconds when the song was added to the playlist. Only playlist
   * tracks carry it; every other list leaves it off.
   */
  addedAt?: number | null;
  /**
   * Release year YouTube Music shows for the song. Only the player fills it, from
   * the song-info request it makes when a song starts; list payloads leave it
   * off, and songs YouTube has no year for stay without one.
   */
  year?: string | null;
}

export interface PlaylistDetails {
  owned: boolean;
  id: string;
  privacy: PlaylistPrivacy;
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
  fromCache?: boolean;
  /**
   * Cursor for the page of tracks after the loaded ones, or null when every
   * track is here. Pass it to `getPlaylistPage` to load more.
   */
  nextToken: string | null;
}

/** One more page of a playlist's tracks, with the cursor after it. */
export interface PlaylistPage {
  tracks: Track[];
  nextToken: string | null;
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
  fromCache?: boolean;
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
  fromCache?: boolean;
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
  /** The counterpart's own kind; the music-video rendition is `..._OMV`. */
  videoType?: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC" | null;
}

export interface WatchTrack {
  videoId: string;
  title: string;
  length: string | null;
  thumbnail: Thumbnail[] | null;
  likeStatus: LikeStatus | null;
  videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC" | null;
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
  connected: boolean;
  state: "off" | "connecting" | "connected" | "waiting" | "invalid" | "error";
  message: string;
}

export interface WatchPlaylist {
  tracks: WatchTrack[];
  playlistId: string | null;
  lyrics: string | null;
  related?: string | null;
}

export interface WatchTunerChip {
  id: string;
  text: string;
  playlistId: string;
}

export interface LyricLine {
  text: string;
  startMs: number;
  endMs: number;
}

export interface Lyrics {
  /** The song's lyrics, or null when YouTube Music has none for it. */
  lyrics: string | null;
  /** Attribution YouTube Music shows, e.g. "Source: LyricFind". */
  source: string | null;
  /** True when `lines` carries per-line timings to highlight against. */
  hasTimestamps: boolean;
  /** Timed lines, empty for plain lyrics. */
  lines: LyricLine[];
}

export interface TranslatedLyrics extends Lyrics {
  /** Detected language of the original, e.g. "es", or null when unknown. */
  language: string | null;
  /** False when the song is already in the requested language; `lyrics` is null in that case. */
  translated: boolean;
}

export interface AudioStream {
  url: string;
  mimeType: string;
  bitrate: number;
  itag: number;
  audioQuality: string;
  expiresInSeconds: number;
}

export type SearchFilter =
  | "songs"
  | "videos"
  | "albums"
  | "artists"
  | "playlists"
  | "community_playlists"
  | "featured_playlists"
  | "profiles"
  | "podcasts"
  | "episodes";

export type SearchScope = "library" | "uploads";

export type SearchKind =
  | "song"
  | "video"
  | "album"
  | "artist"
  | "playlist"
  | "profile"
  | "podcast"
  | "episode";

/** One flattened YouTube Music search row. */
export interface SearchResult {
  kind: SearchKind;
  title: string;
  subtitle: string;
  artists: Artist[];
  album: Album | null;
  thumbnails: Thumbnail[];
  videoId: string | null;
  browseId: string | null;
  playlistId: string | null;
  duration: string;
  durationSeconds: number;
  views: string | null;
  explicit: boolean;
  inLibrary: boolean;
  year: string | null;
  itemCount: number | null;
  videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV";
  /** Default-search section label ("Top result", "Songs", ...); null when filtered. */
  category: string | null;
  resultType: string;
}

/** One YouTube Music search suggestion: the plain text the flyout completes with. */
export type SearchSuggestion = string;

/** One renderer console entry, forwarded to Python in dev through dev_log. */
export interface DevLogEntry {
  level: "log" | "warn" | "error";
  message: string;
  source?: string;
  line?: number;
}
