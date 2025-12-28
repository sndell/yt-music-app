type MultiplePlaylists = {
  title: string;
  playlistId: string;
  thumbnails: Array<{
    url: string;
    width: number;
    height: number;
  }>;
  description: string;
  count?: string;
  author?: Array<{
    name: string;
    id: string;
  }>;
}

type SinglePlaylist = {
  owned: boolean;
  id: string;
  privacy: "UNLISTED" | "PUBLIC" | "PRIVATE";
  description: string | null;
  views: number;
  duration: string;
  trackCount: number;
  title: string;
  thumbnails: {
    url: string;
    width: number;
    height: number;
  }[];
  author: {
    name: string;
    id: string;
  };
  year: string;
  related: never[];
  tracks: {
    videoId: string;
    title: string;
    artists: {
      name: string;
      id: string;
    }[];
    album: {
      name: string;
      id: string;
    } | null;
    likeStatus: "LIKE" | "INDIFFERENT" | "DISLIKE";
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
    thumbnails: {
      url: string;
      width: number;
      height: number;
    }[];
    isAvailable: boolean;
    isExplicit: boolean;
    videoType: "MUSIC_VIDEO_TYPE_ATV" | "MUSIC_VIDEO_TYPE_OMV";
    views: number | null;
    duration: string;
    duration_seconds: number;
    setVideoId: string;
  }[];
  duration_seconds: number;
};


type GetPlaylistsResponse = MultiplePlaylists[];
type GetPlaylistItemsResponse = SinglePlaylist;


