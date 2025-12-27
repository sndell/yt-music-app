type YouTubePlaylist = {
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

type GetPlaylistsResponse = YouTubePlaylist[];

