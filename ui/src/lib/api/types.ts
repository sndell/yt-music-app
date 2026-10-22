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

/**
 * The sidebar's playlist list ("liked playlists"), cached whole in Python so a
 * launch paints it from disk and refreshes behind the list.
 */
export interface LibraryPlaylists {
  playlists: PlaylistSummary[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

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
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

export interface LibraryAlbums {
  albums: LibraryAlbum[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

export interface LibraryArtists {
  artists: LibraryArtist[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
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
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

/** One category tile on the Moods & genres page. `params` opens its playlists. */
export interface MoodCategory {
  title: string;
  params: string;
  /** YouTube's own color for the tile, `#rrggbb`, or null when the page sends none. */
  color: string | null;
}

/** One of YouTube's groupings: "For you", "Moods & moments", "Genres". */
export interface MoodSection {
  title: string;
  categories: MoodCategory[];
}

export interface MoodCategories {
  sections: MoodSection[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

export interface MoodPlaylists {
  playlists: PlaylistSummary[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

/**
 * One Explore row. A song or a video plays; an album, playlist or artist opens
 * its own page. The kind is the section's, not the id's: a chart row and a
 * new-video row are both `videoId` rows, and only the section tells them apart.
 */
export type ExploreItemKind = "song" | "video" | "album" | "playlist" | "artist";

export interface ExploreItem {
  kind: ExploreItemKind;
  title: string;
  subtitle: string;
  artists: Artist[];
  thumbnails: Thumbnail[];
  videoId: string | null;
  playlistId: string | null;
  browseId: string | null;
  explicit: boolean;
  /** Set on playable items, so the player knows a video rendition from a track. */
  videoType?: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC" | null;
}

/** How one Explore section draws its contents. */
export type ExploreSectionLayout = "cards" | "songs" | "moods";

export interface ExploreSection {
  /** YouTube's carousel id (`new_releases`, `trending`, ...). */
  key: string;
  title: string;
  layout: ExploreSectionLayout;
  /** The rows of a `cards` or `songs` section; empty for `moods`. */
  items: ExploreItem[];
  /** The tiles of a `moods` section; empty for every other layout. */
  categories: MoodCategory[];
}

export interface ExploreFeed {
  sections: ExploreSection[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
}

/**
 * One row of the watch playlist's Related tab. A song plays; an album, playlist
 * or artist opens its own page; a `text` row is YouTube's about-the-artist
 * paragraph, which has nothing to open. Rows share the Home item's field set.
 */
export type RelatedItemKind = "song" | "album" | "playlist" | "artist" | "text";

export interface RelatedItem {
  kind: RelatedItemKind;
  title: string;
  subtitle: string;
  artists: Artist[];
  thumbnails: Thumbnail[];
  videoId: string | null;
  playlistId: string | null;
  browseId: string | null;
  explicit: boolean;
  /** Set on playable rows, so the player knows a video rendition from a track. */
  videoType?: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV" | "MUSIC_VIDEO_TYPE_UGC" | null;
}

/** One Related section: YouTube's title and the rows under it, in its order. */
export interface RelatedSection {
  title: string;
  items: RelatedItem[];
}

/** One of YouTube's chart lists: its daily, weekly, or a country's own shelves. */
export interface ChartSection {
  /** YouTube's own list key, e.g. "daily", "weekly", "genres". */
  key: string;
  title: string;
  playlists: PlaylistSummary[];
}

/** One artist on the chart, in YouTube's rank order. */
export interface ChartArtist {
  browseId: string;
  name: string;
  /** YouTube's short count ("2.29M"), or null when it sends none. */
  subscribers: string | null;
  thumbnails: Thumbnail[];
  /** The number YouTube prints beside the row, or null on an unranked read. */
  rank: string | null;
  trend: "up" | "down" | "neutral" | null;
}

export interface Charts {
  /** The country code YouTube served, "ZZ" for the global chart. */
  country: string;
  /** YouTube's own name for it ("Global", "United States"). Empty when it sends none. */
  countryName: string;
  /** ISO 3166-1 alpha-2 codes in YouTube's order. It names only the one it served. */
  countries: string[];
  sections: ChartSection[];
  artists: ChartArtist[];
  fromCache?: boolean;
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
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
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
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
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
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
  /** True when the payload is older than the family's refresh window. */
  stale?: boolean;
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

/** The running build and the newest release the updater found. */
export interface UpdateStatus {
  current: string;
  latest: string;
  available: boolean;
  /** False in a dev window, where there is no exe to replace. */
  frozen: boolean;
  url: string;
  /** Empty when the check worked; a sentence the row can show when it did not. */
  error: string;
}

/** What the helper is doing after a download, so the row can say so. */
export interface UpdateInstall {
  version: string;
  restarting: boolean;
}
