import type { WatchTrack } from "@/lib/api";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { cn } from "@/util/cn";
import { useEffect, useRef, useState } from "react";
import { usePlayer } from "../context/PlayerContext";

const EMBED_EASE = "ease-[cubic-bezier(0.22,1,0.36,1)]";

export const QueuePanel = () => {
  const {
    queue,
    queueOpen,
    queueLoading,
    videoVisible,
    currentSong,
    currentQueueIndex,
    playFromQueue,
    playTrackNext,
    addTrackToQueue,
    startMix,
  } = usePlayer();
  const [menu, setMenu] = useState<{ track: WatchTrack; x: number; y: number } | null>(null);
  const embedOpen = videoVisible && Boolean(currentSong);
  const currentTrack = currentQueueIndex >= 0 ? queue[currentQueueIndex] : null;
  const played = currentTrack ? queue.slice(0, currentQueueIndex) : [];
  const upcoming = currentTrack ? queue.slice(currentQueueIndex + 1) : queue;
  const listRef = useRef<HTMLDivElement>(null);
  const nowPlayingRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const heading = nowPlayingRef.current;
    if (!list || !heading) return;

    let frame = 0;
    let cancelled = false;

    frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const top = heading.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      const start = list.scrollTop;
      const distance = top - start;
      if (Math.abs(distance) < 2) {
        list.scrollTop = top;
        return;
      }

      const duration = 220;
      const startTime = performance.now();
      const step = (now: number) => {
        if (cancelled) return;
        const t = Math.min(1, (now - startTime) / duration);
        list.scrollTop = t === 1 ? top : start + distance * (1 - (1 - t) ** 3);
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [currentSong?.videoId, currentQueueIndex, queue.length]);

  return (
    <div
      aria-hidden={!queueOpen}
      inert={!queueOpen}
      className={cn(
        `flex flex-col shrink-0 my-1.5 min-h-0 overflow-hidden transition-[width,margin-right] duration-500 ${EMBED_EASE}`,
        queueOpen ? "mr-1.5 w-72" : "mr-0 w-0"
      )}
    >
      <div
        aria-hidden={!embedOpen}
        style={{ gridTemplateRows: embedOpen ? "1fr" : "0fr" }}
        className={`grid shrink-0 transition-[grid-template-rows] duration-500 ${EMBED_EASE}`}
      >
        <div className="overflow-hidden min-h-0">
          <div className="mb-1.5 overflow-hidden rounded-xl bg-primary p-1.5">
            <div id="queue-embed" className="overflow-hidden w-full bg-black rounded-lg aspect-video" />
          </div>
        </div>
      </div>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-xl bg-primary">
        <div className="flex gap-1 items-center px-2 py-2">
          
          {/* <span className="size-10 shrink-0" /> */}
          <div className="flex flex-1 gap-2 justify-center items-center min-w-0">
            <h2 className="font-semibold">Queue</h2>
            {queue.length > 0 && <span className="text-sm text-primary-dark">{queue.length}</span>}
          </div>
          {/* <button
            type="button"
            onClick={toggleVideo}
            aria-pressed={embedOpen}
            aria-label={embedOpen ? "Hide video" : "Show video"}
            className={cn(
              "grid size-10 cursor-pointer place-items-center rounded-full transition-colors duration-200",
              embedOpen
                ? "bg-[oklch(0.24_0_0)] text-white hover:bg-[oklch(0.27_0_0)]"
                : "text-primary-dark hover:bg-primary-light hover:text-primary"
            )}
          >
            <span className="text-lg icon-[solar--video-frame-play-horizontal-linear]" />
          </button> */}
        </div>
        <div ref={listRef} className="overflow-y-auto flex-1 px-1.5 pb-2 min-h-0 scrollbar-thin [overflow-anchor:none]">
          {queueLoading && queue.length === 0 && (
            <div className="grid place-items-center py-8">
              <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
            </div>
          )}
          {!queueLoading && queue.length === 0 && (
            <p className="px-2 py-8 text-sm text-center text-primary-dark">Play a song to fill the queue.</p>
          )}
          {played.length > 0 && (
            <p className="px-1.5 pt-0.5 pb-1 text-xs font-semibold text-primary-dark">Previously played</p>
          )}
          {played.map((track, index) => (
            <QueueItem
              key={`${track.videoId}-${index}`}
              track={track}
              isCurrent={false}
              onPlay={() => playFromQueue(track, index)}
              onOpenMenu={(x, y) => setMenu({ track, x, y })}
            />
          ))}
          {currentTrack && (
            <>
              <p
                ref={nowPlayingRef}
                className={cn("px-1.5 pb-1 text-xs font-semibold text-primary-dark", played.length > 0 ? "pt-3" : "pt-0.5")}
              >
                Now playing
              </p>
              <QueueItem
                track={currentTrack}
                isCurrent
                onPlay={() => playFromQueue(currentTrack, currentQueueIndex)}
                onOpenMenu={(x, y) => setMenu({ track: currentTrack, x, y })}
              />
            </>
          )}
          {currentTrack && queueLoading && upcoming.length === 0 && (
            <div className="grid place-items-center py-6" role="status" aria-label="Loading next tracks">
              <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
            </div>
          )}
          {currentTrack && upcoming.length > 0 && (
            <p className="px-1.5 pt-3 pb-1 text-xs font-semibold text-primary-dark">Next</p>
          )}
          {upcoming.map((track, index) => {
            const queueIndex = currentTrack ? currentQueueIndex + 1 + index : index;
            return (
              <QueueItem
                key={`${track.videoId}-${queueIndex}`}
                track={track}
                isCurrent={false}
                onPlay={() => playFromQueue(track, queueIndex)}
                onOpenMenu={(x, y) => setMenu({ track, x, y })}
              />
            );
          })}
        </div>
      </div>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => startMix(menu.track)}
          onPlayNext={() => playTrackNext(menu.track)}
          onAddToQueue={() => addTrackToQueue(menu.track)}
        />
      )}
    </div>
  );
};

const QueueItem = ({
  track,
  isCurrent,
  onPlay,
  onOpenMenu,
}: {
  track: WatchTrack;
  isCurrent: boolean;
  onPlay: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) => {
  const thumbnailUrl = track.thumbnail?.[0]?.url;
  const artists = (track.artists ?? []).map((artist) => artist.name).join(", ");

  return (
    <button
      type="button"
      onClick={onPlay}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!track.videoId) return;
        onOpenMenu(event.clientX, event.clientY);
      }}
      className={cn(
        "flex gap-2 items-center p-1.5 w-full text-left rounded-lg transition-colors cursor-pointer",
        isCurrent ? "bg-primary-light text-primary" : "text-primary-dark hover:text-primary hover:bg-primary-light"
      )}
    >
      <span className={cn("w-0.5 h-8 rounded-full shrink-0", isCurrent ? "bg-accent" : "bg-transparent")} />
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" className="object-cover w-10 h-10 rounded-sm shrink-0" />
      ) : (
        <span className="grid place-items-center w-10 h-10 rounded-sm shrink-0 bg-primary-light">
          <span className="icon-[solar--music-note-linear] text-primary-dark" />
        </span>
      )}
      <span className="flex flex-col flex-1 min-w-0">
        <span className="text-sm truncate">{track.title}</span>
        <span className="text-xs truncate text-primary-dark">{artists}</span>
      </span>
      <span className="text-xs shrink-0 text-primary-dark">{track.length}</span>
    </button>
  );
};
