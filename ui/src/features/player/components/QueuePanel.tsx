import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { WatchTrack } from "@/lib/api";
import { TrackRow } from "@/components/ui/TrackRow";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { applyEdgeMask } from "@/components/ui/useEdgeFade";
import { ReorderItem, ReorderList, consumeDragClick, stableDragId } from "@/components/ui/reorder";
import { suppressScrollDismiss } from "@/components/ui/menuDom";
import { cn } from "@/util/cn";
import { hexToRgba } from "@/util/hex_to_rgba";
import { usePlayer } from "../context/PlayerContext";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";
import { averageLuminance, largestCover, parseHex, readableAccent, useVibrantCover } from "../lib/coverAccent";
import { TunerMenu } from "./TunerMenu";
import { LyricsPanel } from "./LyricsPanel";
import { RelatedPanel } from "./RelatedPanel";

const waveMask =
  "radial-gradient(130% 80% at 42% -6%, #000 0%, rgba(0,0,0,0.88) 26%, rgba(0,0,0,0.42) 60%, transparent 92%), radial-gradient(72% 46% at 64% 58%, rgba(0,0,0,0.72) 0%, transparent 76%)";

const CoverWash = ({ url, sampleUrl, color }: { url?: string; sampleUrl?: string; color: string | null }) => {
  const [shownUrl, setShownUrl] = useState(url);
  const [visible, setVisible] = useState(Boolean(url));
  const [coverIsDark, setCoverIsDark] = useState(false);

  useEffect(() => {
    if (!url) {
      setVisible(false);
      return;
    }
    if (url === shownUrl) {
      setVisible(true);
      return;
    }
    setVisible(false);
    const timeout = window.setTimeout(() => {
      setShownUrl(url);
      setVisible(true);
    }, 320);
    return () => window.clearTimeout(timeout);
  }, [url, shownUrl]);

  useEffect(() => {
    const source = sampleUrl || shownUrl;
    if (!source) {
      setCoverIsDark(false);
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const size = 24;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, size, size);
      try {
        const luminance = averageLuminance(context.getImageData(0, 0, size, size).data);
        if (!cancelled) setCoverIsDark(luminance < 0.22);
      } catch {
        if (!cancelled) setCoverIsDark(false);
      }
    };
    image.onerror = () => {
      if (!cancelled) setCoverIsDark(false);
    };
    image.src = source;
    return () => {
      cancelled = true;
    };
  }, [sampleUrl, shownUrl]);

  const tone = color ? readableAccent(color) : null;
  // A dark cover can carry more colour; a bright one needs a heavier scrim.
  const dark = coverIsDark;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{ maskImage: waveMask, WebkitMaskImage: waveMask }}
      >
        {tone && (
          <>
            <div
              className="absolute -top-20 left-1/2 h-72 w-[150%] -translate-x-1/2 rounded-full blur-3xl"
              style={{ background: hexToRgba(tone, dark ? 0.5 : 0.4) }}
            />
            <div
              className="absolute top-[26%] left-[14%] h-64 w-64 rounded-full blur-3xl"
              style={{ background: hexToRgba(tone, dark ? 0.34 : 0.26) }}
            />
            <div
              className="absolute top-[60%] right-[-18%] h-64 w-64 rounded-full blur-3xl"
              style={{ background: hexToRgba(tone, dark ? 0.24 : 0.16) }}
            />
          </>
        )}
        {shownUrl && (
          <>
            <img
              src={shownUrl}
              alt=""
              className={cn(
                "absolute top-[-18%] left-1/2 h-80 w-[180%] max-w-none object-cover blur-3xl saturate-200 animate-queue-wash",
                "transition-opacity duration-500",
                visible ? (dark ? "opacity-55" : "opacity-38") : "opacity-0"
              )}
            />
            <img
              src={shownUrl}
              alt=""
              className={cn(
                "absolute top-[22%] left-1/2 h-[28rem] w-[210%] max-w-none object-cover blur-3xl saturate-200 animate-queue-wash-low",
                "transition-opacity duration-500",
                visible ? (dark ? "opacity-35" : "opacity-22") : "opacity-0"
              )}
            />
          </>
        )}
      </div>

      {/*
        Always-on scrim. The wash gives the panel its colour, but every queue
        row sits on top of it, so the panel stays dark enough to read.
      */}
      <div className={cn("absolute inset-0", dark ? "bg-primary/30" : "bg-primary/55")} />
      <div
        className={cn(
          "absolute inset-0 bg-linear-to-b to-primary",
          dark ? "from-primary/30 via-primary/10" : "from-primary/45 via-primary/15"
        )}
      />
    </div>
  );
};

const QUEUE_EASE = "ease-[cubic-bezier(0.22,1,0.36,1)]";
/** Fixed virtual row heights, so a large queue only renders what is on screen. */
const QUEUE_ROW_HEIGHT = 52;
const QUEUE_LABEL_HEIGHT = 28;

type QueueEntry =
  | { kind: "label"; key: string; text: string }
  | { kind: "loading"; key: string }
  | { kind: "track"; key: string; track: WatchTrack; index: number };

/** One tab of the queue panel. Queue and Lyrics share the panel's width. */
const PanelTab = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={active}
    onClick={onClick}
    className={cn(
      "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors duration-200",
      active ? "bg-white/10 text-primary" : "text-primary-dark hover:bg-white/5 hover:text-primary"
    )}
  >
    {children}
  </button>
);

export const QueuePanel = () => {
  const {
    queue,
    queueOpen,
    queueLoading,
    queueTuner,
    queueChips,
    selectQueueTuner,
    currentSong,
    lyrics,
    relatedId,
    relatedTitle,
    currentQueueIndex,
    queueRevision,
    queueFill,
    shufflePending,
    playFromQueue,
    reorderQueue,
    playTrackNext,
    addTrackToQueue,
    startMix,
  } = usePlayer();
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } = usePlaylist();
  const [menu, setMenu] = useState<{ track: WatchTrack; x: number; y: number } | null>(null);
  const [newPlaylistFor, setNewPlaylistFor] = useState<string[] | null>(null);
  const [tunerAnchor, setTunerAnchor] = useState<HTMLButtonElement | null>(null);
  const [tunerOpen, setTunerOpen] = useState(false);
  const [tab, setTab] = useState<"queue" | "lyrics" | "related">("queue");
  // The Lyrics and Related tabs exist only while the playing song has them, so
  // a song without either falls back to the queue instead of an empty tab.
  const lyricsAvailable = lyrics !== null;
  const relatedAvailable = relatedId !== null;
  const activeTab =
    tab === "lyrics" && lyricsAvailable
      ? "lyrics"
      : tab === "related" && relatedAvailable
        ? "related"
        : "queue";
  const tunerCloseRef = useRef(0);

  const openTuner = (element: HTMLButtonElement) => {
    window.clearTimeout(tunerCloseRef.current);
    setTunerAnchor(element);
    setTunerOpen(true);
  };

  const closeTuner = () => {
    setTunerOpen(false);
    window.clearTimeout(tunerCloseRef.current);
    tunerCloseRef.current = window.setTimeout(() => setTunerAnchor(null), 200);
  };

  useEffect(() => () => window.clearTimeout(tunerCloseRef.current), []);
  const currentTrack = currentQueueIndex >= 0 ? queue[currentQueueIndex] : null;
  const dragIds = useMemo(() => queue.map((track) => stableDragId(track)), [queue]);
  const listRef = useRef<HTMLDivElement>(null);
  const coverUrl = largestCover(currentTrack);

  // Flat list of labels + tracks so the queue can be virtualized.
  const entries = useMemo<QueueEntry[]>(() => {
    const list: QueueEntry[] = [];
    queue.forEach((track, index) => {
      if (currentTrack && index === 0 && currentQueueIndex > 0) {
        list.push({ kind: "label", key: `prev-${index}`, text: "Previous" });
      }
      if (currentTrack && index === currentQueueIndex) {
        list.push({ kind: "label", key: `now-${index}`, text: "Now playing" });
      }
      if (currentTrack && index === currentQueueIndex + 1) {
        list.push({ kind: "label", key: `next-${index}`, text: "Next" });
      }
      list.push({ kind: "track", key: dragIds[index], track, index });
      if (currentTrack && queueLoading && index === currentQueueIndex && index === queue.length - 1) {
        list.push({ kind: "loading", key: `loading-${index}` });
      }
    });
    return list;
  }, [queue, dragIds, currentTrack, currentQueueIndex, queueLoading]);

  const nowPlayingIndex = entries.findIndex((entry) => entry.kind === "label" && entry.text === "Now playing");

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => (entries[index].kind === "label" ? QUEUE_LABEL_HEIGHT : QUEUE_ROW_HEIGHT),
    overscan: 10,
    getItemKey: (index) => entries[index].key,
  });

  const nowPlayingOffset =
    nowPlayingIndex >= 0 ? (virtualizer.getOffsetForIndex(nowPlayingIndex, "start")?.[0] ?? null) : null;
  const sampleUrl = currentTrack?.thumbnail?.find((thumb) => thumb.url?.startsWith("data:"))?.url;
  const coverColor = useVibrantCover(coverUrl, currentTrack?.videoId, sampleUrl);

  // Pin Now playing on a song change (including the queue that loads for it)
  // and when the end of the queue appends more tracks. Reorder, play next,
  // and add-to-queue move the index without either of those.
  useEffect(() => {
    const list = listRef.current;
    if (!list || nowPlayingOffset == null) return;
    const target = nowPlayingOffset;

    let frame = 0;
    let cancelled = false;

    frame = requestAnimationFrame(() => {
      if (cancelled) return;
      // The pin is the app scrolling itself; open menus must survive it.
      suppressScrollDismiss(400);
      const start = list.scrollTop;
      const distance = target - start;
      if (Math.abs(distance) < 2) {
        list.scrollTop = target;
        return;
      }

      const duration = 220;
      const startTime = performance.now();
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - startTime) / duration);
        list.scrollTop = t === 1 ? target : start + distance * (1 - (1 - t) ** 3);
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [currentSong?.videoId, queueRevision, queueFill, nowPlayingOffset]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;

    const update = () => {
      const max = Math.max(0, list.scrollHeight - list.clientHeight);
      const pinned = nowPlayingOffset != null && Math.abs(nowPlayingOffset - list.scrollTop) <= 2;
      applyEdgeMask(list, list.scrollTop > 1 && !pinned, max - list.scrollTop > 1);
    };

    update();
    const resize = new ResizeObserver(update);
    resize.observe(list);
    list.addEventListener("scroll", update, { passive: true });
    return () => {
      resize.disconnect();
      list.removeEventListener("scroll", update);
    };
  }, [queue.length, queueLoading, currentQueueIndex, nowPlayingOffset]);

  return (
    <div
      aria-hidden={!queueOpen}
      inert={!queueOpen}
      className={cn(
        `flex flex-col shrink-0 my-1.5 min-h-0 overflow-hidden transition-[width,margin-right] duration-500 ${QUEUE_EASE}`,
        queueOpen ? (activeTab === "lyrics" ? "mr-1.5 w-96" : "mr-1.5 w-72") : "mr-0 w-0"
      )}
    >
      <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl bg-primary">
        <CoverWash url={coverUrl} sampleUrl={sampleUrl} color={coverColor} />
        <div
          role="tablist"
          aria-label="Queue panel"
          className="relative z-10 flex gap-1 items-center px-1.5 py-1.5 [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
        >
          <PanelTab active={activeTab === "queue"} onClick={() => setTab("queue")}>
            <span>Queue</span>
            {queue.length > 0 && !shufflePending && (
              <span className="text-xs text-primary-dark">{queue.length}</span>
            )}
          </PanelTab>
          {lyricsAvailable && (
            <PanelTab active={activeTab === "lyrics"} onClick={() => setTab("lyrics")}>
              Lyrics
            </PanelTab>
          )}
          {relatedAvailable && (
            <PanelTab active={activeTab === "related"} onClick={() => setTab("related")}>
              Related
            </PanelTab>
          )}
        </div>
        <ReorderList ids={dragIds} axis="y" onMove={reorderQueue}>
          <div
            ref={listRef}
            className={cn(
              "relative z-10 overflow-y-auto flex-1 px-1.5 pb-2 min-h-0 scrollbar-thin [overflow-anchor:none] [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]",
              activeTab !== "queue" && "hidden"
            )}
          >
            {shufflePending && (
              <div
                role="status"
                aria-label="Reading the playlist to shuffle it"
                className="grid place-items-center gap-2 py-8"
              >
                <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
                <span className="text-xs text-primary-dark">Shuffling playlist…</span>
              </div>
            )}
            {!shufflePending && queueLoading && queue.length === 0 && (
              <div className="grid place-items-center py-8">
                <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
              </div>
            )}
            {!shufflePending && !queueLoading && queue.length === 0 && (
              <p className="px-2 py-8 text-sm text-center text-primary-dark">Play a song to fill the queue.</p>
            )}
            {!shufflePending && (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const entry = entries[virtualItem.index];
                  if (entry.kind === "label") {
                    return (
                      <p
                        key={entry.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: QUEUE_LABEL_HEIGHT,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="px-1.5 pt-0.5 pb-1 text-xs font-semibold text-primary-dark"
                      >
                        {entry.text}
                      </p>
                    );
                  }
                  if (entry.kind === "loading") {
                    return (
                      <div
                        key={entry.key}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: QUEUE_ROW_HEIGHT,
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                        className="grid place-items-center"
                        role="status"
                        aria-label="Loading next tracks"
                      >
                        <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
                      </div>
                    );
                  }
                  const { track, index } = entry;
                  const isCurrent = currentTrack != null && index === currentQueueIndex;
                  return (
                    <ReorderItem key={entry.key} id={entry.key} offsetY={virtualItem.start} height={QUEUE_ROW_HEIGHT}>
                      <QueueItem
                        track={track}
                        isCurrent={isCurrent}
                        accent={isCurrent ? coverColor : undefined}
                        menuOpen={menu?.track === track}
                        onPlay={() => playFromQueue(track, index)}
                        onOpenMenu={(x, y) => setMenu({ track, x, y })}
                      />
                    </ReorderItem>
                  );
                })}
              </div>
            )}
          </div>
        </ReorderList>
        {queueChips.length > 1 && (
          <div
            className={cn(
              "relative z-10 shrink-0 border-t border-white/5 px-1.5 pb-1.5 pt-1.5",
              activeTab !== "queue" && "hidden"
            )}
          >
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={tunerOpen}
              onPointerDown={(event) => {
                event.preventDefault();
                const element = event.currentTarget;
                if (tunerAnchor) closeTuner();
                else openTuner(element);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  const element = event.currentTarget;
                  if (tunerAnchor) closeTuner();
                  else openTuner(element);
                }
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-primary-dark transition-colors duration-200 hover:bg-white/10 hover:text-primary"
            >
              <span className="shrink-0 text-sm icon-[solar--tuning-2-linear]" />
              <span key={queueTuner} className="flex-1 min-w-0 text-left truncate animate-tuner-swap">
                {queueTuner}
              </span>
              <span
                className={cn(
                  "shrink-0 text-sm transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] icon-[solar--alt-arrow-up-linear]",
                  tunerOpen && "rotate-180"
                )}
              />
            </button>
          </div>
        )}
        {activeTab === "lyrics" && lyrics && <LyricsPanel lyrics={lyrics} />}
        {activeTab === "related" && relatedId && <RelatedPanel relatedId={relatedId} title={relatedTitle} />}
      </div>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
          addToPlaylistVideoIds={[menu.track.videoId]}
          playlists={playlists}
          recommendedPlaylists={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onLoadRecommendations={() => void fetchRecommendedPlaylists()}
          onNewPlaylist={() => {
            setNewPlaylistFor([menu.track.videoId]);
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
      {tunerAnchor && (
        <TunerMenu
          open={tunerOpen}
          trigger={tunerAnchor}
          chips={queueChips}
          value={queueTuner}
          onSelect={selectQueueTuner}
          onClose={closeTuner}
        />
      )}
    </div>
  );
};


const QueueItem = ({
  track,
  isCurrent,
  accent,
  menuOpen = false,
  onPlay,
  onOpenMenu,
}: {
  track: WatchTrack;
  isCurrent: boolean;
  accent?: string | null;
  /** Keeps the row in its hover state while its context menu is open. */
  menuOpen?: boolean;
  onPlay: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) => {
  const artists = (track.artists ?? []).map((artist) => artist.name).join(", ");
  const tone = accent ? readableAccent(accent) : null;
  const toneChannels = tone ? parseHex(tone) : null;
  // A silver or white accent at the usual 20% disappears into a light wash.
  const pale = Boolean(
    toneChannels && Math.max(...toneChannels) >= 140 && Math.max(...toneChannels) - Math.min(...toneChannels) < 24
  );

  return (
    <TrackRow
      title={track.title}
      subtitle={artists}
      thumbnails={track.thumbnail}
      density="panel"
      current={isCurrent}
      menuOpen={menuOpen}
      reveal
      trailing={<span className="shrink-0 text-xs text-primary-dark">{track.length}</span>}
      shouldActivate={consumeDragClick}
      onActivate={onPlay}
      onContextMenu={track.videoId ? onOpenMenu : undefined}
      coverClassName="bg-primary-light"
      rowClassName={cn(
        "duration-700",
        isCurrent ? "text-primary" : "text-primary-dark hover:text-primary",
        isCurrent && !tone && "bg-primary-light"
      )}
      rowStyle={
        isCurrent && tone
          ? {
              backgroundColor: hexToRgba(tone, pale ? 0.4 : 0.2),
              boxShadow: `inset 0 0 0 1px ${hexToRgba(tone, pale ? 0.58 : 0.34)}`,
            }
          : undefined
      }
    />
  );
};
