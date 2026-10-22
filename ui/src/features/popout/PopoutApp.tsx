import { useCallback, useEffect, useRef, useState } from "react";
import { ToastProvider } from "@/components/ui/Toast";
import { IconButton } from "@/components/ui/IconButton";
import { playhead } from "@/features/player/lib/playhead";
import { PlaylistProvider } from "@/features/playlist/hooks/usePlaylist.tsx";
import { PyBridge } from "@/lib/api";
import type { PopoutPrefs } from "@/lib/api/types";
import { useVibrantCover } from "@/features/player/lib/coverAccent";
import { hexToRgba } from "@/util/hex_to_rgba";
import { cn } from "@/util/cn";
import { POPOUT_CHANNEL, type PopoutCommand, type PopoutMessage, type PopoutState, EMPTY_POPOUT_STATE } from "./lib/channel";
import { coverOf } from "./lib/cover";
import { NowPlaying, PopoutProgress } from "./components/NowPlaying";
import { WindowButtons } from "./components/WindowButtons";

/** Below this viewport height the strip is the right surface. */
const COLLAPSED_MAX_HEIGHT = 220;

/**
 * The popout page: window chrome, the surface, and the channel to the player.
 *
 * Mounted instead of the app when the page is loaded with `?popout=1`. It
 * deliberately mounts neither PlayerProvider nor Player: this window has no
 * audio element, so it cannot play a song twice or write history.
 */
export const PopoutApp = () => {
  const { state, send } = usePopoutChannel();
  const [prefs, setPrefs] = useState<PopoutPrefs | null>(null);
  // The window's own height decides the layout, so a resize from anywhere (the
  // chevron, a restore at startup) lands on the right surface. Python owns the
  // size; this page reads it.
  const [collapsed, setCollapsed] = useState(() => window.innerHeight < COLLAPSED_MAX_HEIGHT);

  useEffect(() => {
    const sync = () => setCollapsed(window.innerHeight < COLLAPSED_MAX_HEIGHT);
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  useEffect(() => {
    void PyBridge.getPopout().then((result) => {
      if (result.success) setPrefs(result.data);
    });
  }, []);

  // This page mounts without App, so it has to block the browser menu itself.
  // Row menus open on contextmenu and do their own preventDefault.
  useEffect(() => {
    const block = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", block, true);
    return () => document.removeEventListener("contextmenu", block, true);
  }, []);

  // Lyrics read this window's playhead for the highlighted line and seek
  // through it; the seek has to land on the audio the main window owns.
  useEffect(() => {
    playhead.setSeeker((seconds) => send({ kind: "seek", position: seconds }));
  }, [send]);

  useEffect(() => {
    playhead.set(state.position);
  }, [state.position]);

  const pinned = prefs?.pinned ?? true;

  // One accent for the window: the header wash and the strip both tint from
  // the same cover.
  const cover = coverOf(state.song);
  const sampleUrl = state.song?.thumbnails?.find((thumb) => thumb.url?.startsWith("data:"))?.url;
  const accent = useVibrantCover(cover, state.song?.videoId, sampleUrl);

  const togglePinned = async () => {
    const result = await PyBridge.setPopoutPinned(!pinned);
    if (result.success) setPrefs(result.data);
  };

  const toggleCollapsed = async () => {
    await PyBridge.setPopoutCollapsed(!collapsed);
  };

  return (
    <ToastProvider>
      <PlaylistProvider>
        {/* No header band: the window buttons render inside the section below,
            and every non-interactable surface here is a drag region (see
            `DRAG_REGION_DIRECT_TARGET_ONLY` in app/main.py). */}
        <div className="flex h-screen flex-col overflow-hidden bg-primary text-primary">
          {collapsed ? (
            <CollapsedStrip
              state={state}
              send={send}
              cover={cover}
              accent={accent}
              pinned={pinned}
              onTogglePinned={() => void togglePinned()}
              onToggleCollapsed={() => void toggleCollapsed()}
              onClose={() => send({ kind: "close-popout" })}
            />
          ) : (
            <NowPlaying
              state={state}
              send={send}
              cover={cover}
              accent={accent}
              pinned={pinned}
              onTogglePinned={() => void togglePinned()}
              onToggleCollapsed={() => void toggleCollapsed()}
              onClose={() => send({ kind: "close-popout" })}
            />
          )}
        </div>
      </PlaylistProvider>
    </ToastProvider>
  );
};

/** The strip: enough to see and steer the song while it sits out of the way. */
const CollapsedStrip = ({
  state,
  send,
  cover,
  accent,
  pinned,
  onTogglePinned,
  onToggleCollapsed,
  onClose,
}: {
  state: PopoutState;
  send: (command: PopoutCommand) => void;
  cover: string | undefined;
  accent: string | null;
  pinned: boolean;
  onTogglePinned: () => void;
  onToggleCollapsed: () => void;
  onClose: () => void;
}) => {
  const { song, position, duration, playing } = state;

  return (
    <div className="pywebview-drag-region relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(80% 150% at 6% 50%, ${accent ? hexToRgba(accent, 0.3) : "rgba(255,255,255,0.03)"} 0%, transparent 70%)`,
        }}
      />
      <div className="pywebview-drag-region relative flex min-w-0 flex-1 items-center gap-3 px-4">
        {cover ? (
          <img src={cover} alt="" className="pywebview-drag-region size-10 shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/[0.06]">
            <span className="icon-[solar--music-note-linear] text-lg text-primary-dark" />
          </div>
        )}
        <div className="pywebview-drag-region min-w-0 flex-1">
          <p className={cn("pywebview-drag-region truncate text-[13px] font-medium leading-4", song ? "text-primary" : "text-primary-dark")}>
            {song?.title ?? "Nothing playing"}
          </p>
          <p className="pywebview-drag-region mt-0.5 truncate text-[11px] leading-4 text-primary-dark">
            {song?.artists.map((artist) => artist.name).filter(Boolean).join(", ") ?? "Open the main window to start"}
          </p>
        </div>
        <IconButton
          iconClass="icon-[solar--skip-previous-bold]"
          label="Previous"
          size="sm"
          tone="ghost"
          iconScale="secondary"
          onClick={() => send({ kind: "previous" })}
        />
        <IconButton
          iconClass={playing ? "icon-[solar--pause-bold]" : "icon-[solar--play-bold]"}
          label={playing ? "Pause" : "Play"}
          size="sm"
          tone="solid"
          iconScale="secondary"
          className="size-9"
          onClick={() => send({ kind: playing ? "pause" : "play" })}
        />
        <IconButton
          iconClass="icon-[solar--skip-next-bold]"
          label="Next"
          size="sm"
          tone="ghost"
          iconScale="secondary"
          onClick={() => send({ kind: "next" })}
        />
      </div>

      {/* The window controls float at the strip's top-right corner. */}
      <div className="absolute right-1 top-1 z-20 flex items-center">
        <WindowButtons
          pinned={pinned}
          collapsed
          onTogglePinned={onTogglePinned}
          onToggleCollapsed={onToggleCollapsed}
          onClose={onClose}
        />
      </div>
      <PopoutProgress
        position={position}
        duration={duration}
        showTimes={false}
        onSeek={(seconds) => send({ kind: "seek", position: seconds })}
      />
    </div>
  );
};

/**
 * Receives the main window's snapshots and sends commands back.
 *
 * A tick carries only the clock; the snapshot carries the song, queue and
 * lyrics. Splitting them keeps a 100-song queue off the channel four times a
 * second.
 */
const usePopoutChannel = () => {
  const [state, setState] = useState<PopoutState>(EMPTY_POPOUT_STATE);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    const channel = new BroadcastChannel(POPOUT_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<PopoutMessage>) => {
      const message = event.data;
      if (message.type === "state") {
        setState(message.state);
      } else if (message.type === "tick") {
        setState((current) => ({
          ...current,
          playing: message.playing,
          position: message.position,
          duration: message.duration,
          loop: message.loop,
        }));
      }
    };
    const hello = () => channel.postMessage({ type: "hello" } satisfies PopoutMessage);
    hello();
    // A restore that races the main window's startup would otherwise sit empty
    // until the next song change.
    const retry = window.setTimeout(hello, 800);
    return () => {
      window.clearTimeout(retry);
      channel.close();
      channelRef.current = null;
    };
  }, []);

  const send = useCallback((command: PopoutCommand) => {
    channelRef.current?.postMessage({ type: "command", command } satisfies PopoutMessage);
  }, []);

  return { state, send };
};
