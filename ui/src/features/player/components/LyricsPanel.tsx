import type { LyricLine } from "@/lib/api";
import { cn } from "@/util/cn";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { playhead } from "../lib/playhead";
import type { SongLyrics } from "../context/PlayerContext";

/** Index of the line playing at `seconds`, or -1 before the first one starts. */
const lineAt = (lines: LyricLine[], seconds: number) => {
  const ms = seconds * 1000;
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startMs > ms) break;
    active = index;
  }
  return active;
};

/**
 * The line playing right now.
 *
 * Reads the playback clock through `useSyncExternalStore`, so a playback tick
 * re-renders only when the highlighted line changes rather than several times
 * a second. Songs without timings have no lines and stay at -1.
 */
const useActiveLine = (lines: LyricLine[]) => {
  const subscribe = useCallback(
    (notify: () => void) => (lines.length === 0 ? () => {} : playhead.subscribe(notify)),
    [lines]
  );
  const getSnapshot = useCallback(() => (lines.length === 0 ? -1 : lineAt(lines, playhead.get())), [lines]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * The Lyrics tab of the queue panel, for the resolved playing song.
 *
 * YouTube Music returns timings for some songs and a plain block for others, so
 * the timed view highlights the playing line and the plain view is shown as is.
 */
export const LyricsPanel = ({ lyrics }: { lyrics: SongLyrics }) => {
  const lines = lyrics.lines;
  const active = useActiveLine(lines);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);

  // Keep the playing line in the middle of the panel as playback moves.
  useEffect(() => {
    const list = listRef.current;
    const line = activeRef.current;
    if (active < 0 || !list || !line) return;
    const target = line.offsetTop - list.clientHeight / 2 + line.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [active]);

  return (
    <div
      ref={listRef}
      className="relative z-10 overflow-y-auto flex-1 min-h-0 px-4 py-3 scrollbar-thin [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
    >
      {lines.length > 0 ? (
        <div className="pb-4">
          {lines.map((line, index) => (
            <p
              key={index}
              ref={index === active ? activeRef : undefined}
              className={cn(
                // White and bold against dimmed lines: the two panel text tokens
                // are only 0.15 lightness apart, which the highlight cannot carry.
                "text-[15px] leading-7 transition-[color,opacity,font-weight] duration-300",
                index === active ? "font-semibold text-white" : "text-primary-dark opacity-50"
              )}
            >
              {line.text}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-[15px] leading-7 whitespace-pre-line text-primary">{lyrics.text}</p>
      )}
      {lyrics.source && <p className="mt-6 text-xs text-primary-dark">{lyrics.source}</p>}
    </div>
  );
};
