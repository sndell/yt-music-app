import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PyBridge, type HomeItem, type HomeShelf, type Track } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { IconButton } from "@/components/ui/IconButton";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { SnapRow } from "@/components/ui/SnapRow";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { cn } from "@/util/cn";

const PAGE_SIZE = 12;
const PAGE_SLIDE_FALLBACK_MS = 500;

type QuickPickSlide = {
  id: number;
  from: number;
  to: number;
  dir: 1 | -1;
};

const toTrack = (item: HomeItem): Track => ({
  videoId: item.videoId ?? "",
  title: item.title,
  artists: item.artists ?? [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: item.thumbnails ?? [],
  isAvailable: true,
  isExplicit: item.explicit,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "",
  durationSeconds: 0,
  setVideoId: "",
});

const itemKey = (item: HomeItem, index: number) =>
  `${item.kind}-${item.videoId ?? item.browseId ?? item.playlistId ?? index}`;

const albumOpenId = (item: HomeItem) => {
  if (item.kind !== "album") return null;
  if (item.browseId) return item.browseId;
  if (item.playlistId?.startsWith("OLAK5uy_")) return item.playlistId;
  return null;
};

export const Home = () => {
  const [shelves, setShelves] = useState<HomeShelf[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [menu, setMenu] = useState<
    { kind: "track"; track: Track; x: number; y: number } | { kind: "playlist"; playlistId: string; x: number; y: number } | null
  >(null);
  const requestIdRef = useRef(0);
  const [, navigate] = useLocation();
  const { currentSong, startMix, playTracks, playTrackNext, addTrackToQueue, playPlaylist, queuePlaylist } = usePlayer();

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setShelves(null);
    setError(null);
    setPage(0);
    return PyBridge.getHome().then((result) => {
      if (requestId !== requestIdRef.current) return;
      if (result.success) {
        setShelves(result.data.shelves);
        setError(null);
      } else {
        setShelves([]);
        setError(result.error.message);
      }
    });
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("ytmusic-auth-changed", refresh);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("ytmusic-auth-changed", refresh);
    };
  }, [load]);

  const openItem = (item: HomeItem) => {
    if (item.kind === "song" && item.videoId) {
      startMix(toTrack(item));
      return;
    }
    if (item.kind === "artist" && item.browseId) {
      navigate(`/artist/${item.browseId}`);
      return;
    }
    const albumId = albumOpenId(item);
    if (albumId) {
      navigate(`/album/${albumId}`);
      return;
    }
    if (item.kind === "playlist" && item.playlistId) navigate(`/playlist/${item.playlistId}`);
  };

  const playAlbum = (item: HomeItem) => {
    const id = albumOpenId(item);
    if (!id) return;
    void PyBridge.getAlbum(id).then((result) => {
      if (!result.success) return;
      const audioPlaylistId = result.data.audioPlaylistId;
      if (!audioPlaylistId) return;
      void playPlaylist(audioPlaylistId, "play");
    });
  };

  const hasContent = shelves !== null && shelves.length > 0;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto p-4 sm:p-6">
        {error && <div className="mb-3 text-sm text-red-400">{error}</div>}

        {shelves === null && (
          <div className="grid place-items-center py-8" role="status">
            <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
          </div>
        )}

        {shelves !== null && shelves.length === 0 && !error && (
          <div className="py-8 text-sm text-primary-dark">
            Sign in from Settings.{" "}
            <button type="button" onClick={() => void load()} className="cursor-pointer text-primary hover:underline">
              Reload
            </button>
          </div>
        )}

        {hasContent && (
          <div className="flex flex-col gap-6">
            {shelves.map((shelf) =>
              shelf.layout === "row" ? (
                <HomeRow
                  key={shelf.title}
                  shelf={shelf}
                  currentVideoId={currentSong?.videoId}
                  onOpen={openItem}
                  onPlayAlbum={playAlbum}
                  onPlayPlaylist={(playlistId) => void playPlaylist(playlistId, "play")}
                  onOpenMenu={(item, x, y) => {
                    if (item.kind === "playlist" && item.playlistId) {
                      setMenu({ kind: "playlist", playlistId: item.playlistId, x, y });
                      return;
                    }
                    if (!item.videoId) return;
                    setMenu({ kind: "track", track: toTrack(item), x, y });
                  }}
                />
              ) : (
                <QuickPicks
                  key={shelf.title}
                  shelf={shelf}
                  page={page}
                  setPage={setPage}
                  currentVideoId={currentSong?.videoId}
                  onPlayAll={() => playTracks(shelf.items.filter((item) => item.videoId).map(toTrack))}
                  onOpen={openItem}
                  onOpenMenu={(item, x, y) => {
                    if (!item.videoId) return;
                    setMenu({ kind: "track", track: toTrack(item), x, y });
                  }}
                />
              )
            )}
          </div>
        )}
      </div>
      {menu?.kind === "track" && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
        />
      )}
      {menu?.kind === "playlist" && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onShuffle={() => void playPlaylist(menu.playlistId, "shuffle")}
          onStartMix={() => void playPlaylist(menu.playlistId, "mix")}
          onPlayNext={() => void queuePlaylist(menu.playlistId, "next")}
          onAddToQueue={() => void queuePlaylist(menu.playlistId, "end")}
        />
      )}
    </div>
  );
};

const HomeRow = ({
  shelf,
  currentVideoId,
  onOpen,
  onOpenMenu,
  onPlayAlbum,
  onPlayPlaylist,
}: {
  shelf: HomeShelf;
  currentVideoId: string | undefined;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
  onPlayAlbum: (item: HomeItem) => void;
  onPlayPlaylist: (playlistId: string) => void;
}) => (
  <section className="group/snap">
    <h2 className="text-xl font-bold">{shelf.title}</h2>
    <SnapRow>
      {shelf.items.map((item, index) => (
        <HomeCard
          key={itemKey(item, index)}
          item={item}
          playing={Boolean(item.videoId) && currentVideoId === item.videoId}
          onOpen={() => onOpen(item)}
          onOpenMenu={(x, y) => onOpenMenu(item, x, y)}
          onPlayAlbum={() => onPlayAlbum(item)}
          onPlayPlaylist={() => {
            if (item.kind === "playlist" && item.playlistId) onPlayPlaylist(item.playlistId);
          }}
        />
      ))}
    </SnapRow>
  </section>
);

const HomeCard = ({
  item,
  playing,
  onOpen,
  onOpenMenu,
  onPlayAlbum,
  onPlayPlaylist,
}: {
  item: HomeItem;
  playing: boolean;
  onOpen: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onPlayAlbum: () => void;
  onPlayPlaylist: () => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = item.thumbnails?.[0]?.url;
  const isPlaylist = item.kind === "playlist" && Boolean(item.playlistId);
  const isAlbum = Boolean(albumOpenId(item));
  const canOpen =
    item.kind === "song"
      ? Boolean(item.videoId)
      : item.kind === "artist"
        ? Boolean(item.browseId)
        : item.kind === "album"
          ? isAlbum
          : Boolean(item.playlistId);

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (isPlaylist || (item.kind === "song" && item.videoId)) onOpenMenu(event.clientX, event.clientY);
      }}
      className="group w-36 shrink-0 sm:w-40"
    >
      <div
        className={cn(
          "relative aspect-square overflow-hidden rounded-md bg-secondary",
          playing && "ring-2 ring-accent"
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          disabled={!canOpen}
          aria-label={item.kind === "song" ? `Play ${item.title}` : `Open ${item.title}`}
          className="absolute inset-0 cursor-pointer disabled:cursor-default"
        >
          {thumbnailUrl && !failed ? (
            <img src={thumbnailUrl} alt="" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-cover" />
          ) : (
            <span className="grid h-full w-full place-items-center">
              <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
            </span>
          )}
        </button>
        {isPlaylist || isAlbum ? (
          <span
            onClick={onOpen}
            className="pointer-events-none absolute inset-0 cursor-pointer opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
          >
            {isPlaylist && (
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  const rect = event.currentTarget.getBoundingClientRect();
                  onOpenMenu(rect.left, rect.bottom);
                }}
                className="pointer-events-none absolute top-1 right-1 group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
              >
                <IconButton
                  iconClass="icon-[solar--menu-dots-bold]"
                  label={`More options for ${item.title}`}
                  size="sm"
                  tone="ghost"
                  className="pointer-events-none text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.8)] group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
                />
              </span>
            )}
            <button
              type="button"
              aria-label={`Play ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                if (isAlbum) onPlayAlbum();
                else onPlayPlaylist();
              }}
              className="group/play pointer-events-none absolute right-1.5 bottom-1.5 grid size-10 cursor-pointer place-items-center text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.8)] group-hover:pointer-events-auto group-focus-within:pointer-events-auto"
            >
              <RevealIcon grow iconClassName="icon-[solar--play-bold] text-2xl" />
            </button>
          </span>
        ) : (
          <span className={mediaScrimClass}>
            <RevealIcon
              grow={item.kind === "song"}
              interactive={item.kind === "song"}
              onClick={item.kind === "song" && canOpen ? onOpen : undefined}
              iconClassName={
                item.kind === "song" ? "icon-[solar--play-bold] text-2xl" : "icon-[solar--library-linear] text-2xl"
              }
            />
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onOpen}
        disabled={!canOpen}
        className="mt-2 block w-full cursor-pointer text-left disabled:cursor-default"
      >
        <span className="block truncate text-sm font-medium">{item.title}</span>
        {item.subtitle && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
            {item.explicit && <ExplicitBadge />}
            <span className="truncate">{item.subtitle}</span>
          </span>
        )}
      </button>
    </div>
  );
};

const QuickPicks = ({
  shelf,
  page,
  setPage,
  currentVideoId,
  onPlayAll,
  onOpen,
  onOpenMenu,
}: {
  shelf: HomeShelf;
  page: number;
  setPage: (value: number | ((value: number) => number)) => void;
  currentVideoId: string | undefined;
  onPlayAll: () => void;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
}) => {
  const pageCount = Math.max(1, Math.ceil(shelf.items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const [shownPage, setShownPage] = useState(currentPage);
  const [slide, setSlide] = useState<QuickPickSlide | null>(null);
  const slideSerialRef = useRef(0);
  const pendingPageRef = useRef<number | null>(null);
  const completedIdRef = useRef<number | null>(null);

  const itemsFor = (pageIndex: number) =>
    shelf.items.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);

  const go = (direction: 1 | -1) => {
    const destination = pendingPageRef.current ?? slide?.to ?? shownPage;
    const target = Math.max(0, Math.min(pageCount - 1, destination + direction));
    if (target === destination) return;
    setPage(target);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pendingPageRef.current = null;
      setSlide(null);
      setShownPage(target);
      return;
    }
    if (slide) {
      pendingPageRef.current = target;
      return;
    }
    setSlide({
      id: ++slideSerialRef.current,
      from: shownPage,
      to: target,
      dir: direction,
    });
  };

  const finishSlide = (active: QuickPickSlide) => {
    if (completedIdRef.current === active.id) return;
    completedIdRef.current = active.id;
    const pending = pendingPageRef.current;
    pendingPageRef.current = null;
    const next = pending === null ? null : Math.max(0, Math.min(pageCount - 1, pending));
    if (next !== null && next !== active.to) {
      setShownPage(active.to);
      setSlide({
        id: ++slideSerialRef.current,
        from: active.to,
        to: next,
        dir: next > active.to ? 1 : -1,
      });
      return;
    }
    setShownPage(active.to);
    setSlide(null);
  };

  const finishSlideRef = useRef(finishSlide);
  useEffect(() => {
    finishSlideRef.current = finishSlide;
  });
  useEffect(() => {
    if (!slide) return;
    const active = slide;
    const timer = window.setTimeout(() => finishSlideRef.current(active), PAGE_SLIDE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  const grid = (pageIndex: number, className?: string) => (
    <QuickPickGrid
      className={className}
      items={itemsFor(pageIndex)}
      currentVideoId={currentVideoId}
      onOpen={onOpen}
      onOpenMenu={onOpenMenu}
    />
  );

  const shownItems = itemsFor(shownPage);

  return (
    <section className="min-w-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold">{shelf.title}</h2>
        {shelf.items.length > 0 && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPlayAll}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-primary px-3 py-1.5 text-sm transition-colors hover:bg-primary-light"
            >
              Play all
            </button>
            <IconButton
              iconClass="icon-[solar--alt-arrow-left-linear]"
              label="Previous page"
              size="sm"
              tone="outline"
              disabled={currentPage === 0}
              onClick={() => go(-1)}
            />
            <IconButton
              iconClass="icon-[solar--alt-arrow-right-linear]"
              label="Next page"
              size="sm"
              tone="outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => go(1)}
            />
          </div>
        )}
      </div>
      {(slide || shownItems.length > 0) && (
        <div className="mt-4 overflow-hidden">
          {slide ? (
            <div
              key={slide.id}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return;
                finishSlide(slide);
              }}
              className={cn(
                "pointer-events-none flex w-[200%] items-start",
                slide.dir === 1 ? "animate-qp-next" : "animate-qp-prev"
              )}
            >
              {slide.dir === 1 ? (
                <>
                  {grid(slide.from, "w-1/2 shrink-0")}
                  {grid(slide.to, "w-1/2 shrink-0")}
                </>
              ) : (
                <>
                  {grid(slide.to, "w-1/2 shrink-0")}
                  {grid(slide.from, "w-1/2 shrink-0")}
                </>
              )}
            </div>
          ) : (
            grid(shownPage)
          )}
        </div>
      )}
    </section>
  );
};

const QuickPickGrid = ({
  items,
  currentVideoId,
  onOpen,
  onOpenMenu,
  className,
}: {
  items: HomeItem[];
  currentVideoId: string | undefined;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
  className?: string;
}) => (
  <div className={cn("grid min-w-0 grid-cols-1 gap-x-6 gap-y-0.5 lg:grid-cols-2 xl:grid-cols-3", className)}>
    {items.map((item, index) => (
      <QuickPickRow
        key={itemKey(item, index)}
        item={item}
        playing={Boolean(item.videoId) && currentVideoId === item.videoId}
        onPlay={() => onOpen(item)}
        onOpenMenu={(x, y) => onOpenMenu(item, x, y)}
      />
    ))}
  </div>
);

const QuickPickRow = ({
  item,
  playing,
  onPlay,
  onOpenMenu,
}: {
  item: HomeItem;
  playing: boolean;
  onPlay: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = item.thumbnails?.[0]?.url;

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        if (!item.videoId) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
      className="min-w-0"
    >
      <button
        type="button"
        onClick={onPlay}
        aria-label={`Play ${item.title}`}
        className={cn(
          "group flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-primary-light",
          playing && "bg-primary-light"
        )}
      >
        <div className="relative size-11 shrink-0 overflow-hidden rounded-md bg-secondary">
          {thumbnailUrl && !failed ? (
            <img src={thumbnailUrl} alt="" draggable={false} onError={() => setFailed(true)} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <span className="icon-[solar--music-note-linear] text-primary-dark" />
            </div>
          )}
          <span className={mediaScrimClass}>
            <RevealIcon iconClassName="icon-[solar--play-bold] text-lg" />
          </span>
        </div>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{item.title}</span>
          {item.subtitle && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
              {item.explicit && <ExplicitBadge />}
              <span className="truncate">{item.subtitle}</span>
            </span>
          )}
        </span>
      </button>
    </div>
  );
};
