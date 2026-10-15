import type { WatchTrack, WatchTunerChip } from "@/lib/api";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { CreatePlaylistDialog } from "@/components/ui/CreatePlaylistDialog";
import { cn } from "@/util/cn";
import { applyEdgeMask } from "@/components/ui/useEdgeFade";
import { hexToRgba } from "@/util/hex_to_rgba";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ReorderItem, ReorderList, consumeDragClick, stableDragId } from "@/components/ui/reorder";
import { usePlayer } from "../context/PlayerContext";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";

const colorCache = new Map<string, string | null>();

const saturationValue = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;
  return [saturation * 100, max * 100] as const;
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

const parseHex = (hex: string) => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] as const;
};

/**
 * Near-black covers disappear into the queue. Keep a real hue and raise it
 * enough to read. A few levels of channel noise on black is not a hue —
 * scaling it paints the row a color the cover does not have.
 */
const readableAccent = (hex: string) => {
  const channels = parseHex(hex);
  if (!channels) return hex;
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  if (max >= 96) return hex;
  if (max === 0 || max - min < 24) return "#9a9a9a";
  const scale = 176 / max;
  return toHex(
    Math.min(255, Math.round(channels[0] * scale)),
    Math.min(255, Math.round(channels[1] * scale)),
    Math.min(255, Math.round(channels[2] * scale)),
  );
};

const averageLuminance = (data: Uint8ClampedArray) => {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    sum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    count += 1;
  }
  return count === 0 ? 1 : sum / count;
};

/** Same saturation + value pick as playlist pages, weighted toward saturated swatches. */
const vibrantFromPixels = (data: Uint8ClampedArray) => {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let index = 0; index < data.length; index += 4 * 6) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];
    if (a < 200) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  let best: [number, number, number] | null = null;
  let bestScore = -1;
  let vibrant: [number, number, number] | null = null;
  let vibrantScore = -1;

  for (const bucket of [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 20)) {
    const rgb: [number, number, number] = [
      Math.round(bucket.r / bucket.n),
      Math.round(bucket.g / bucket.n),
      Math.round(bucket.b / bucket.n),
    ];
    const [saturation, value] = saturationValue(...rgb);
    const score = saturation + value;
    if (score > bestScore) {
      bestScore = score;
      best = rgb;
    }
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    if (saturation >= 18 && chroma >= 24 && Math.max(...rgb) >= 40) {
      const weighted = saturation * 1.8 + value * 0.55;
      if (weighted > vibrantScore) {
        vibrantScore = weighted;
        vibrant = rgb;
      }
    }
  }

  const picked = vibrant ?? best;
  return picked ? toHex(...picked) : null;
};

const sampleCover = (url: string) =>
  new Promise<string | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const size = 48;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, size, size);
      try {
        resolve(vibrantFromPixels(context.getImageData(0, 0, size, size).data));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });

const largestCover = (track: WatchTrack | null) => {
  const thumbs = track?.thumbnail ?? [];
  if (thumbs.length === 0) return undefined;
  return thumbs.reduce((best, thumb) => ((thumb.width ?? 0) > (best.width ?? 0) ? thumb : best)).url;
};

/** Near-black channel noise is not a usable accent. A real dark hue still is. */
const usableAccent = (hex: string | null | undefined) => {
  const channels = hex ? parseHex(hex) : null;
  if (!channels) return false;
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  return max >= 40 || max - min >= 24;
};

const useVibrantCover = (url: string | undefined, videoId: string | undefined, fallbackUrl?: string) => {
  const cacheKey = url ? `${url}|${videoId ?? ""}` : "";
  const cachedAtStart = cacheKey ? colorCache.get(cacheKey) : undefined;
  const [color, setColor] = useState<string | null>(usableAccent(cachedAtStart) ? (cachedAtStart ?? null) : null);

  useEffect(() => {
    if (!url) {
      setColor(null);
      return;
    }
    const cached = colorCache.get(cacheKey);
    if (usableAccent(cached)) {
      setColor(cached ?? null);
      return;
    }

    let cancelled = false;
    const finish = (value: string | null) => {
      colorCache.set(cacheKey, value);
      if (!cancelled) setColor(value);
    };

    void (async () => {
      const readCover = window.pywebview?.api?.get_cover_color;
      if (typeof readCover === "function") {
        try {
          const value = await readCover(url);
          if (usableAccent(value)) {
            finish(value);
            return;
          }
        } catch {
          // The palette call can miss; the in-page sample still has the cover.
        }
      }
      const fromCover = await sampleCover(url);
      if (usableAccent(fromCover)) {
        finish(fromCover);
        return;
      }
      // The largest thumb is often a host that blocks pixel reads. A data-URL
      // thumb of the same art can still be sampled.
      if (fallbackUrl && fallbackUrl !== url) {
        const fromFallback = await sampleCover(fallbackUrl);
        if (usableAccent(fromFallback)) {
          finish(fromFallback);
          return;
        }
      }
      // Some cover hosts block pixel reads. The video poster is the same art and can be sampled.
      if (videoId) {
        const fromPoster = await sampleCover(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
        if (usableAccent(fromPoster)) {
          finish(fromPoster);
          return;
        }
      }
      finish(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [url, videoId, fallbackUrl, cacheKey]);

  return color;
};

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

export const QueuePanel = () => {
  const {
    queue,
    queueOpen,
    queueLoading,
    queueTuner,
    queueChips,
    selectQueueTuner,
    currentSong,
    currentQueueIndex,
    queueRevision,
    queueFill,
    playFromQueue,
    reorderQueue,
    playTrackNext,
    addTrackToQueue,
    startMix,
  } = usePlayer();
  const { addToPlaylist, playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists, createPlaylist } = usePlaylist();
  const [menu, setMenu] = useState<{ track: WatchTrack; x: number; y: number } | null>(null);
  const [newPlaylistFor, setNewPlaylistFor] = useState<string[] | null>(null);
  const [tunerAnchor, setTunerAnchor] = useState<HTMLButtonElement | null>(null);
  const [tunerOpen, setTunerOpen] = useState(false);
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
        queueOpen ? "mr-1.5 w-72" : "mr-0 w-0"
      )}
    >
      <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl bg-primary">
        <CoverWash url={coverUrl} sampleUrl={sampleUrl} color={coverColor} />
        <div className="relative z-10 flex gap-1 items-center px-2 py-2 [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
          <div className="flex flex-1 gap-2 justify-center items-center min-w-0">
            <h2 className="font-semibold">Queue</h2>
            {queue.length > 0 && <span className="text-sm text-primary-dark">{queue.length}</span>}
          </div>
        </div>
        <ReorderList ids={dragIds} axis="y" onMove={reorderQueue}>
          <div
            ref={listRef}
            className="relative z-10 overflow-y-auto flex-1 px-1.5 pb-2 min-h-0 scrollbar-thin [overflow-anchor:none] [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
          >
            {queueLoading && queue.length === 0 && (
              <div className="grid place-items-center py-8">
                <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
              </div>
            )}
            {!queueLoading && queue.length === 0 && (
              <p className="px-2 py-8 text-sm text-center text-primary-dark">Play a song to fill the queue.</p>
            )}
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
          </div>
        </ReorderList>
        {queueChips.length > 1 && (
          <div className="relative z-10 shrink-0 border-t border-white/5 px-1.5 pb-1.5 pt-1.5">
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
      </div>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
          onAddToPlaylist={(playlistId) => void addToPlaylist(playlistId, [menu.track.videoId])}
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

const TunerMenu = ({
  open,
  trigger,
  chips,
  value,
  onSelect,
  onClose,
}: {
  open: boolean;
  trigger: HTMLButtonElement | null;
  chips: WatchTunerChip[];
  value: string;
  onSelect: (chip: WatchTunerChip) => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const anchor = trigger?.getBoundingClientRect();
    if (!menu || !anchor) return;
    // Match the trigger exactly so the menu reads as an extension of it.
    menu.style.width = `${anchor.width}px`;
    const rect = menu.getBoundingClientRect();
    let left = anchor.left;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - rect.width);
    // The trigger sits at the bottom of the queue, so the menu opens upward
    // unless the space below is the better fit.
    const spaceBelow = window.innerHeight - anchor.bottom;
    const spaceAbove = anchor.top;
    const top =
      spaceBelow >= rect.height + 8 || spaceBelow >= spaceAbove
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - rect.height - 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    // Grow out of the corner nearest the trigger.
    menu.style.transformOrigin = `${left < anchor.left ? "right" : "left"} ${top < anchor.top ? "bottom" : "top"}`;
  }, [trigger]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Scrolling the menu itself must not dismiss it; scrolling the queue behind
    // it should.
    const onScroll = (event: Event) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose, trigger]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={cn(
        "fixed z-50 max-h-80 overflow-y-auto overscroll-contain rounded-xl bg-black p-1 shadow-[0_10px_28px_rgb(0_0_0/0.65)] scrollbar-thin",
        "transition-[transform,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:scale-95 starting:opacity-0",
        open ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0"
      )}
    >
      {chips.map((chip, index) => {
        const active = chip.id === value;
        return (
          <button
            key={chip.id}
            type="button"
            role="menuitemradio"
            aria-checked={active}
            style={{ animationDelay: open ? `${Math.min(index, 8) * 18}ms` : undefined }}
            onClick={() => {
              onSelect(chip);
              onClose();
            }}
            className={cn(
              "group flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-white/10",
              open && "animate-tuner-swap",
              active ? "text-primary" : "text-primary-dark hover:text-primary"
            )}
          >
            <span className="flex-1 min-w-0 truncate">{chip.text}</span>
            {active && <span className="shrink-0 text-base text-accent icon-[solar--check-circle-bold]" />}
          </button>
        );
      })}
    </div>,
    document.body
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
  const thumbnailUrl = track.thumbnail?.[0]?.url;
  const artists = (track.artists ?? []).map((artist) => artist.name).join(", ");
  const tone = accent ? readableAccent(accent) : null;
  const toneChannels = tone ? parseHex(tone) : null;
  // A silver or white accent at the usual 20% disappears into a light wash.
  const pale = Boolean(
    toneChannels && Math.max(...toneChannels) >= 140 && Math.max(...toneChannels) - Math.min(...toneChannels) < 24
  );

  return (
    <button
      type="button"
      onClick={() => {
        if (consumeDragClick()) return;
        onPlay();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!track.videoId) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
      className={cn(
        "group flex w-full cursor-grab items-center gap-2.5 rounded-lg p-1.5 text-left transition-[background-color,box-shadow,color] duration-700",
        isCurrent ? "text-primary" : "text-primary-dark hover:bg-primary-light hover:text-primary",
        "data-[menu-open=true]:bg-primary-light data-[menu-open=true]:text-primary",
        isCurrent && !tone && "bg-primary-light"
      )}
      data-menu-open={menuOpen ? "true" : undefined}
      style={
        isCurrent && tone
          ? {
              backgroundColor: hexToRgba(tone, pale ? 0.4 : 0.2),
              boxShadow: `inset 0 0 0 1px ${hexToRgba(tone, pale ? 0.58 : 0.34)}`,
            }
          : undefined
      }
    >
      <span className="relative size-10 shrink-0 overflow-hidden rounded-md">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center bg-primary-light">
            <span className="icon-[solar--music-note-linear] text-primary-dark" />
          </span>
        )}
        <span className={mediaScrimClass}>
          <RevealIcon iconClassName="icon-[solar--play-bold] text-base" />
        </span>
      </span>
      <span className="flex flex-col flex-1 min-w-0">
        <span className="text-sm truncate">{track.title}</span>
        <span className="text-xs truncate text-primary-dark">{artists}</span>
      </span>
      <span className="text-xs shrink-0 text-primary-dark">{track.length}</span>
    </button>
  );
};
