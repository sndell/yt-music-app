import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PyBridge, type Track } from "@/lib/api";
import { usePlayer } from "@/features/player";
import { LibraryTrackRow } from "@/features/library";

/** One LibraryTrackRow: a 40px cover plus that row's comfortable padding. */
const ROW_HEIGHT = 56;

const Reload = ({ onReload }: { onReload: () => void }) => (
  <button type="button" onClick={onReload} className="cursor-pointer text-primary hover:underline">
    Reload
  </button>
);

/**
 * Recently played songs, newest first, as YouTube Music returns them. The list
 * is read fresh on every open: playing a song appends to the history, so a
 * cached page would be missing the song the user just heard.
 */
export const History = () => {
  const [songs, setSongs] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { currentSong, playTracks } = usePlayer();

  const load = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setError(null);
    void PyBridge.getHistory().then((result) => {
      if (requestId !== requestIdRef.current) return;
      if (!result.success) {
        // An empty list is the account's real state; a failed read is not it,
        // so the message stands in for the list instead of an empty state.
        setSongs([]);
        setError(result.error.message);
        return;
      }
      setSongs(result.data.songs);
    });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("ytmusic-auth-changed", load);
    return () => {
      requestIdRef.current += 1;
      window.removeEventListener("ytmusic-auth-changed", load);
    };
  }, [load]);

  const list = songs ?? [];
  // History repeats a song once per play, so the app-wide videoId match would
  // light every copy at once. Highlight only the first (newest) occurrence so
  // the list keeps the shared convention but lights one row.
  const playingIndex = currentSong ? list.findIndex((track) => track.videoId === currentSong.videoId) : -1;
  const virtualizer = useVirtualizer({
    count: list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-end justify-between gap-3 px-4 pt-4 pb-3 sm:px-6 sm:pt-6">
        <div>
          <Link
            href="/library"
            className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary-dark hover:text-primary"
          >
            <span className="icon-[solar--alt-arrow-left-linear]" aria-hidden="true" />
            Library
          </Link>
          <h1 className="mt-2 text-2xl font-bold">History</h1>
          {list.length > 0 && (
            <p className="mt-1 text-sm text-primary-dark">
              {list.length} {list.length === 1 ? "song" : "songs"}
            </p>
          )}
        </div>
        {list.length > 0 && <Reload onReload={load} />}
      </div>

      <div ref={scrollRef} className="scrollbar flex-1 overflow-y-auto px-3 pb-8 sm:px-4">
        {songs === null && (
          <div className="flex items-center gap-2 py-8 text-sm text-primary-dark" role="status">
            <span className="icon-[solar--loader-linear] animate-spin text-base" aria-hidden="true" />
            Loading recently played songs
          </div>
        )}

        {songs !== null && error && (
          <p className="py-8 text-sm text-primary-dark" role="status">
            {error} <Reload onReload={load} />
          </p>
        )}

        {songs !== null && !error && list.length === 0 && (
          <p className="py-8 text-sm text-primary-dark">
            Songs you play will show up here.
          </p>
        )}

        {list.length > 0 && (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const track = list[row.index];
              return (
                <div
                  key={`${track.videoId}-${row.index}`}
                  className="absolute top-0 left-0 w-full"
                  style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                >
                  <LibraryTrackRow
                    track={track}
                    playing={row.index === playingIndex}
                    onPlay={() => playTracks([track])}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
