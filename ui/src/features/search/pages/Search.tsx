import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useSearch } from "wouter";
import { PyBridge, type SearchFilter, type SearchResult, type SearchScope } from "@/lib/api";
import { cn } from "@/util/cn";
import { usePlayer } from "@/features/player";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";
import { BrowseCard } from "@/components/ui/BrowseCard";
import { SnapRow } from "@/components/ui/SnapRow";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { isPlayable, searchHref, searchResultToTrack } from "../lib/searchTarget";
import { SearchRow } from "../components/SearchRow";

const PAGE_LIMIT = 40;

const FILTERS: { value: SearchFilter | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "songs", label: "Songs" },
  { value: "videos", label: "Videos" },
  { value: "albums", label: "Albums" },
  { value: "artists", label: "Artists" },
  { value: "playlists", label: "Playlists" },
];

// A scope narrows the search to part of the account instead of reordering it,
// which is why it sits apart from the filter chips.
const SCOPES: { value: SearchScope; label: string; iconClass: string }[] = [
  { value: "library", label: "Library", iconClass: "icon-[solar--library-linear]" },
  { value: "uploads", label: "Uploads", iconClass: "icon-[solar--cloud-upload-linear]" },
];

const resultKey = (result: SearchResult, index: number) =>
  `${result.kind}-${result.videoId ?? result.browseId ?? result.playlistId ?? index}`;

const Chip = ({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
      active ? "bg-primary-light text-primary" : "text-primary-dark hover:bg-primary-light/60 hover:text-primary",
    )}
  >
    {children}
  </button>
);

/**
 * The scope is a binary choice between two parts of the account, not a result
 * type, so it sits apart from the filter chips: outlined pills on the heading
 * row that fill in and show a check while they are on. Picking the active one
 * again clears it, which searches everything.
 */
const ScopeToggle = ({ scope, onSelect }: { scope: SearchScope | ""; onSelect: (next: SearchScope | "") => void }) => (
  <div className="flex shrink-0 items-center gap-1">
    {SCOPES.map((option) => {
      const active = scope === option.value;
      return (
        <button
          key={option.value}
          type="button"
          onClick={() => onSelect(active ? "" : option.value)}
          aria-pressed={active}
          className={cn(
            "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors",
            active
              ? "border-transparent bg-primary-light text-primary"
              : "border-white/40 text-primary-dark hover:border-white/70 hover:text-primary",
          )}
        >
          <span
            className={cn("text-base", active ? "icon-[solar--check-circle-bold] text-accent" : option.iconClass)}
          />
          {option.label}
        </button>
      );
    })}
  </div>
);

const TopResult = ({ result, onSelect }: { result: SearchResult; onSelect: () => void }) => {
  const round = result.kind === "artist" || result.kind === "profile";
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const thumbnailUrl = result.thumbnails[0]?.url;
  const inlinedUrl = inlined?.from === thumbnailUrl ? inlined.url : null;
  const coverSrc = inlinedUrl ?? thumbnailUrl;
  const showCover = Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl;

  const handleCoverError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((bridge) => {
      if (bridge.success && typeof bridge.data === "string" && bridge.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: bridge.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group flex w-full max-w-md cursor-pointer items-center gap-4 rounded-xl p-2 text-left transition-colors hover:bg-primary-light"
    >
      <span
        className={cn(
          "grid size-24 shrink-0 place-items-center overflow-hidden bg-secondary",
          round ? "rounded-full" : "rounded-lg",
        )}
      >
        {showCover && coverSrc ? (
          <img src={coverSrc} alt="" draggable={false} onError={handleCoverError} className="h-full w-full object-cover" />
        ) : (
          <span className="icon-[solar--music-note-linear] text-3xl text-primary-dark" />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-primary-dark">Top result</span>
        <span className="mt-0.5 block truncate text-2xl font-bold text-primary">{result.title}</span>
        {result.subtitle && <span className="mt-1 block truncate text-sm text-primary-dark">{result.subtitle}</span>}
      </span>
    </button>
  );
};

export const Search = () => {
  const rawSearch = useSearch();
  const query = useMemo(() => (new URLSearchParams(rawSearch).get("q") ?? "").trim(), [rawSearch]);
  const [, navigate] = useLocation();
  const { playTracks, startMix, playTrackNext, addTrackToQueue } = usePlayer();
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } = usePlaylist();
  const { add: addRecent } = useRecentSearches();
  const [newPlaylistFor, setNewPlaylistFor] = useState<string[] | null>(null);

  // Filters reset when the query changes, derived during render the way Album does.
  const [selection, setSelection] = useState<{ query: string; filter: SearchFilter | ""; scope: SearchScope | "" }>({
    query,
    filter: "",
    scope: "",
  });
  if (selection.query !== query) setSelection({ query, filter: "", scope: "" });
  const current = selection.query === query ? selection : { query, filter: "" as const, scope: "" as const };
  const { filter, scope } = current;

  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ result: SearchResult; x: number; y: number } | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    (text: string, nextFilter: SearchFilter | "", nextScope: SearchScope | "") => {
      if (!text) {
        requestIdRef.current += 1;
        setResults([]);
        setError(null);
        return;
      }
      addRecent(text);
      const requestId = ++requestIdRef.current;
      setError(null);
      setResults(null);
      void PyBridge.search(text, nextFilter, nextScope, PAGE_LIMIT).then((result) => {
        if (requestId !== requestIdRef.current) return;
        if (result.success) {
          setResults(result.data);
        } else {
          setResults([]);
          setError(result.error.message);
        }
      });
    },
    [addRecent],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => load(query, filter, scope), 0);
    return () => window.clearTimeout(timer);
  }, [load, query, filter, scope]);

  const openResult = (result: SearchResult) => {
    if (isPlayable(result)) {
      const track = searchResultToTrack(result);
      const rest = (results ?? [])
        .filter(isPlayable)
        .map(searchResultToTrack)
        .filter((item) => item.videoId !== track.videoId);
      playTracks([track, ...rest]);
      return;
    }
    const href = searchHref(result);
    if (href) navigate(href);
  };

  const renderTrackList = (items: SearchResult[]) => (
    <div className="flex flex-col">
      {items.map((result, index) => (
        <SearchRow
          key={resultKey(result, index)}
          result={result}
          onSelect={() => openResult(result)}
          onOpenMenu={isPlayable(result) ? (x, y) => setMenu({ result, x, y }) : undefined}
        />
      ))}
    </div>
  );

  const cardFor = (result: SearchResult, index: number) => {
    const href = searchHref(result);
    if (!href) return null;
    return (
      <BrowseCard
        key={resultKey(result, index)}
        href={href}
        title={result.title}
        subtitle={result.subtitle}
        explicit={result.explicit}
        thumbnails={result.thumbnails}
      />
    );
  };

  const CardSection = ({ title, items }: { title: string; items: SearchResult[] }) => (
    <section className="group/snap min-w-0">
      <h2 className="mb-1 text-xl font-bold">{title}</h2>
      <SnapRow>{items.map(cardFor)}</SnapRow>
    </section>
  );

  const renderBody = () => {
    if (!query) {
      return <p className="py-8 text-sm text-primary-dark">Search for songs, albums, artists, and playlists.</p>;
    }
    if (error) {
      return <p className="py-8 text-sm text-red-400">{error}</p>;
    }
    if (results === null) {
      return (
        <div className="grid place-items-center py-16" role="status">
          <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
        </div>
      );
    }
    const items = results;
    if (items.length === 0) {
      return <p className="py-8 text-sm text-primary-dark">No results found.</p>;
    }

    if (filter === "songs" || filter === "videos") {
      return renderTrackList(items);
    }
    if (filter !== "") {
      return <div className="flex flex-wrap gap-x-3 gap-y-5">{items.map(cardFor)}</div>;
    }

    // All: a top result plus one section per type.
    const top = items.find((result) => result.category === "Top result");
    const songs = items.filter((result) => result.kind === "song" || result.kind === "video");
    const albums = items.filter((result) => result.kind === "album");
    const artists = items.filter((result) => result.kind === "artist" || result.kind === "profile");
    const playlists = items.filter((result) => result.kind === "playlist");

    return (
      <div className="flex flex-col gap-8">
        {top && <TopResult result={top} onSelect={() => openResult(top)} />}
        {songs.length > 0 && (
          <section>
            <h2 className="mb-2 text-xl font-bold">Songs</h2>
            {renderTrackList(songs)}
          </section>
        )}
        {albums.length > 0 && <CardSection title="Albums" items={albums} />}
        {artists.length > 0 && <CardSection title="Artists" items={artists} />}
        {playlists.length > 0 && <CardSection title="Playlists" items={playlists} />}
      </div>
    );
  };

  const menuTrack = menu ? searchResultToTrack(menu.result) : null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h1 className="min-w-0 truncate text-2xl font-bold">
              {query ? (
                <>
                  Results for <span className="text-primary-dark">“{query}”</span>
                </>
              ) : (
                "Search"
              )}
            </h1>
            <ScopeToggle
              scope={scope}
              onSelect={(next) => setSelection((state) => ({ ...state, query, scope: next }))}
            />
          </div>

          {/* ytmusicapi refuses a filter alongside the uploads scope, and the
              scope returns the account's uploads whatever the type, so the
              filter row goes with it rather than showing a control that does
              nothing. */}
          {scope !== "uploads" && (
            <div className="scrollbar-none mt-4 flex items-center gap-1 overflow-x-auto pb-1">
              {FILTERS.map((option) => (
                <Chip
                  key={option.value || "all"}
                  active={filter === option.value}
                  onClick={() => setSelection((state) => ({ ...state, query, filter: option.value }))}
                >
                  {option.label}
                </Chip>
              ))}
            </div>
          )}

          <div className="mt-5">{renderBody()}</div>
        </div>
      </div>

      {menu && menuTrack && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menuTrack)}
          onPlayNext={() => playTrackNext(menuTrack)}
          onAddToQueue={() => addTrackToQueue(menuTrack)}
          addToPlaylistVideoIds={[menuTrack.videoId]}
          playlists={playlists}
          recommendedPlaylists={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onLoadRecommendations={() => void fetchRecommendedPlaylists()}
          onNewPlaylist={() => {
            setNewPlaylistFor([menuTrack.videoId]);
            setMenu(null);
          }}
        />
      )}
      {newPlaylistFor && (
        <CreatePlaylistDialog
          onCancel={() => setNewPlaylistFor(null)}
          onSubmit={async (title, description, privacy) => {
            const playlistId = await createPlaylist(title, description, privacy, newPlaylistFor);
            if (playlistId) setNewPlaylistFor(null);
            return playlistId;
          }}
        />
      )}
    </div>
  );
};
