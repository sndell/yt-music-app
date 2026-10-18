import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { LibraryAlbum, LibraryArtist, PlaylistSummary, Track } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";
import { PlaylistTrackList } from "@/features/playlist/components/PlaylistTrackList";
import { BrowseCard } from "@/components/ui/BrowseCard";
import { PlaybackButtons } from "@/components/ui/PlaybackButtons";
import { LibraryTrackRow, useLibraryData } from "@/features/library";
import { cn } from "@/util/cn";

type LibraryView = "all" | "playlists" | "songs" | "albums" | "artists";

const VIEWS: { value: LibraryView; label: string }[] = [
  { value: "all", label: "All" },
  { value: "playlists", label: "Playlists" },
  { value: "songs", label: "Songs" },
  { value: "albums", label: "Albums" },
  { value: "artists", label: "Artists" },
];

// The saved songs are YouTube Music's liked-songs list, so playback and shuffle
// go through that playlist rather than a queue of shuffled local rows.
const LIKED_MUSIC_ID = "LM";
// The All view is a glance, not the whole library. Each section shows a head of
// its list and hands off to its own chip for the rest.
const PREVIEW_SONGS = 8;
const PREVIEW_CARDS = 12;

const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={cn(
      "shrink-0 cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
      active ? "bg-primary-light text-primary" : "text-primary-dark hover:bg-primary-light/60 hover:text-primary",
    )}
  >
    {children}
  </button>
);

const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => (
  <section className="min-w-0">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xl font-bold">{title}</h2>
      {action}
    </div>
    <div className="mt-3">{children}</div>
  </section>
);

const ShowAll = ({ count, label, onClick }: { count: number; label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="shrink-0 cursor-pointer text-sm text-primary-dark hover:underline"
  >
    Show all {count} {label}
  </button>
);

const Grid = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-5">{children}</div>
);

const Loading = ({ label }: { label: string }) => (
  <div className="grid place-items-center py-12" role="status" aria-label={label}>
    <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
  </div>
);

const Empty = ({ message, onReload }: { message: ReactNode; onReload: () => void }) => (
  <p className="py-8 text-sm text-primary-dark">
    {message}{" "}
    <button type="button" onClick={onReload} className="cursor-pointer text-primary hover:underline">
      Reload
    </button>
  </p>
);

const songCountLabel = (count: string | undefined) => {
  if (!count) return null;
  const total = Number(count.replace(/,/g, "").trim());
  if (!Number.isInteger(total) || total < 0) return null;
  return total === 1 ? "1 song" : `${total} songs`;
};

const playlistCard = (playlist: PlaylistSummary) => (
  <BrowseCard
    key={playlist.playlistId}
    href={`/playlist/${playlist.playlistId}`}
    title={playlist.title}
    subtitle={songCountLabel(playlist.count)}
    thumbnails={playlist.thumbnails}
  />
);

const albumCard = (album: LibraryAlbum, index: number) => (
  <BrowseCard
    key={`${album.browseId}-${index}`}
    href={`/album/${album.browseId}`}
    title={album.title}
    subtitle={[...album.artists.map((artist) => artist.name), album.year].filter(Boolean).join(" • ")}
    thumbnails={album.thumbnails}
  />
);

// The library artist list can carry the same channel id twice, so the key
// needs the row index to stay unique.
const artistCard = (artist: LibraryArtist, index: number) => (
  <BrowseCard
    key={`${artist.browseId}-${index}`}
    href={`/artist/${artist.browseId}`}
    title={artist.name}
    subtitle={artist.songCount > 0 ? `${artist.songCount} ${artist.songCount === 1 ? "song" : "songs"}` : null}
    thumbnails={artist.thumbnails}
    shape="circle"
    iconClass="icon-[solar--user-linear]"
  />
);

export const Library = () => {
  const [view, setView] = useState<LibraryView>("playlists");
  const { playlists, isLoading: playlistsLoading } = usePlaylist();
  const { playPlaylist, playTracks, trueShuffle, currentSong } = usePlayer();
  const {
    songs,
    songsError,
    albums,
    albumsError,
    artists,
    artistsError,
    loadSongs,
    loadAlbums,
    loadArtists,
    reload,
    revision,
  } = useLibraryData();

  const wantsSongs = view === "all" || view === "songs";
  const wantsAlbums = view === "all" || view === "albums";
  const wantsArtists = view === "all" || view === "artists";

  // Only the chips in play load, so opening the page fetches nothing until the
  // user asks for a category. `revision` re-runs this after a sign-in reset.
  useEffect(() => {
    if (wantsSongs) loadSongs();
    if (wantsAlbums) loadAlbums();
    if (wantsArtists) loadArtists();
  }, [wantsSongs, wantsAlbums, wantsArtists, revision, loadSongs, loadAlbums, loadArtists]);

  useEffect(() => {
    const onAuthChanged = () => reload();
    window.addEventListener("ytmusic-auth-changed", onAuthChanged);
    return () => window.removeEventListener("ytmusic-auth-changed", onAuthChanged);
  }, [reload]);

  const renderPlaylists = (limit?: number) => {
    if (playlistsLoading && playlists.length === 0) return <Loading label="Loading playlists" />;
    if (playlists.length === 0) {
      return <Empty message="Playlists you create or save will show up here." onReload={reload} />;
    }
    return <Grid>{(limit ? playlists.slice(0, limit) : playlists).map(playlistCard)}</Grid>;
  };

  const renderAlbums = (limit?: number) => {
    if (albumsError) return <Empty message={albumsError} onReload={reload} />;
    if (albums === null) return <Loading label="Loading albums" />;
    if (albums.length === 0) {
      return <Empty message="Albums you save will show up here." onReload={reload} />;
    }
    return <Grid>{(limit ? albums.slice(0, limit) : albums).map(albumCard)}</Grid>;
  };

  const renderArtists = (limit?: number) => {
    if (artistsError) return <Empty message={artistsError} onReload={reload} />;
    if (artists === null) return <Loading label="Loading artists" />;
    if (artists.length === 0) {
      return <Empty message="Artists you follow will show up here." onReload={reload} />;
    }
    return <Grid>{(limit ? artists.slice(0, limit) : artists).map(artistCard)}</Grid>;
  };

  const songsMessage = (
    <Empty message="Songs you like will show up here." onReload={reload} />
  );

  const renderSongs = () => {
    if (songsError) return <Empty message={songsError} onReload={reload} />;
    if (songs === null) return <Loading label="Loading songs" />;
    if (songs.length === 0) return songsMessage;
    return (
      <PlaylistTrackList
        tracks={songs}
        gradient="transparent"
        playlistId={LIKED_MUSIC_ID}
        filterable
        actions={
          <PlaybackButtons
            onPlay={() => void playPlaylist(LIKED_MUSIC_ID, "play")}
            shuffleMenu={{
              onShuffle: () => void playPlaylist(LIKED_MUSIC_ID, "shuffle"),
              onTrueShuffle: () => void trueShuffle(songs),
            }}
          />
        }
      />
    );
  };

  const renderSongPreview = () => {
    if (songsError) return <Empty message={songsError} onReload={reload} />;
    if (songs === null) return <Loading label="Loading songs" />;
    if (songs.length === 0) return songsMessage;
    return (
      <div className="flex flex-col">
        {songs.slice(0, PREVIEW_SONGS).map((track: Track, index) => (
          <LibraryTrackRow
            key={track.videoId}
            track={track}
            playing={currentSong?.videoId === track.videoId}
            onPlay={() => playTracks([track, ...songs.slice(index + 1)])}
          />
        ))}
      </div>
    );
  };

  const more = (total: number, limit: number) => total > limit;

  const renderAll = () => (
    <div className="flex flex-col gap-8">
      <Section title="Playlists">{renderPlaylists(PREVIEW_CARDS)}</Section>
      <Section
        title="Songs"
        action={
          songs && more(songs.length, PREVIEW_SONGS) ? (
            <ShowAll count={songs.length} label="songs" onClick={() => setView("songs")} />
          ) : null
        }
      >
        {renderSongPreview()}
      </Section>
      <Section
        title="Albums"
        action={
          albums && more(albums.length, PREVIEW_CARDS) ? (
            <ShowAll count={albums.length} label="albums" onClick={() => setView("albums")} />
          ) : null
        }
      >
        {renderAlbums(PREVIEW_CARDS)}
      </Section>
      <Section
        title="Artists"
        action={
          artists && more(artists.length, PREVIEW_CARDS) ? (
            <ShowAll count={artists.length} label="artists" onClick={() => setView("artists")} />
          ) : null
        }
      >
        {renderArtists(PREVIEW_CARDS)}
      </Section>
    </div>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold">Library</h1>
            {/* History is a page of its own, so this is a link rather than a
                chip: the chips filter the library in place. */}
            <Link
              href="/history"
              className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium text-primary-dark transition-colors hover:bg-primary-light/60 hover:text-primary"
            >
              <span className="icon-[solar--history-linear]" aria-hidden="true" />
              History
            </Link>
          </div>
          <div className="scrollbar-none mt-4 flex items-center gap-1 overflow-x-auto pb-1">
            {VIEWS.map((option) => (
              <Chip key={option.value} active={view === option.value} onClick={() => setView(option.value)}>
                {option.label}
              </Chip>
            ))}
          </div>
        </div>

        {view === "songs" ? (
          renderSongs()
        ) : (
          <div className="px-4 pb-8 sm:px-6">
            {view === "all" && renderAll()}
            {view === "playlists" && renderPlaylists()}
            {view === "albums" && renderAlbums()}
            {view === "artists" && renderArtists()}
          </div>
        )}
      </div>
    </div>
  );
};
