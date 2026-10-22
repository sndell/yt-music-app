import { useState } from "react";
import type { WatchTrack } from "@/lib/api";
import { IconButton } from "@/components/ui/IconButton";
import { TrackMenu } from "@/components/ui/TrackMenu";
import { LyricsPanel } from "@/features/player/components/LyricsPanel";
import { RatingButtons } from "@/features/player/components/PlayerControls";
import { RelatedPanel } from "@/features/player/components/RelatedPanel";
import { trackToWatchTrack } from "@/features/player/lib/queueModel";
import { usePlaylist } from "@/features/playlist/hooks/usePlaylist.tsx";
import { hexToRgba } from "@/util/hex_to_rgba";
import { cn } from "@/util/cn";
import type { PopoutCommand, PopoutState } from "../lib/channel";
import { clock } from "../lib/format";
import { PopoutQueue } from "./PopoutQueue";

const TABS = ["queue", "lyrics", "related"] as const;
type Tab = (typeof TABS)[number];

const LABELS: Record<Tab, string> = { queue: "Queue", lyrics: "Lyrics", related: "Related" };

/**
 * The always-on-top player's surface.
 *
 * It renders a snapshot from the window that owns the audio and sends commands
 * back; it never holds a player of its own. That is why the like state, the
 * queue and the history write all stay correct while this window is open.
 *
 * Every band is full width and the bars touch the window edges, so the surface
 * reads as one panel rather than a stack of floating cards. The only insets are
 * the 16px text gutter and the 8px list gutter that rows highlight inside.
 */
export const NowPlaying = ({
  state,
  send,
  cover,
  accent,
}: {
  state: PopoutState;
  send: (command: PopoutCommand) => void;
  /** The playing song's largest cover, already chosen by the shell. */
  cover: string | undefined;
  /** That cover's vibrant colour, or null while it is unknown. */
  accent: string | null;
}) => {
  const { song, queue, index, lyrics, relatedId, relatedTitle, shuffle, loop, playing, position, duration } = state;
  const [tab, setTab] = useState<Tab>("lyrics");
  const [menu, setMenu] = useState<{ track: WatchTrack; x: number; y: number } | null>(null);
  const { playlists, recommendedPlaylists, recommendedPending, fetchRecommendedPlaylists } = usePlaylist();

  const lyricsAvailable = lyrics !== null;
  const relatedAvailable = relatedId !== null;
  const activeTab: Tab =
    tab === "lyrics" && !lyricsAvailable ? "queue" : tab === "related" && !relatedAvailable ? "queue" : tab;
  // A song can have neither lyrics nor related ids. Then there is nothing to
  // switch to and the bar would be one wide button, so it is left out.
  const availableTabs = TABS.filter(
    (name) => name === "queue" || (name === "lyrics" ? lyricsAvailable : relatedAvailable),
  );

  const openMenu = (track: WatchTrack, x: number, y: number) => {
    setMenu({ track, x, y });
  };

  const openCurrentMenu = (x: number, y: number) => {
    if (!song?.videoId) return;
    openMenu(trackToWatchTrack(song), x, y);
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-72"
        style={{
          background: `radial-gradient(115% 90% at 50% 0%, ${accent ? hexToRgba(accent, 0.3) : "rgba(255,255,255,0.04)"} 0%, transparent 68%)`,
        }}
      />

      {song ? (
        <>
          <div
            className="relative flex shrink-0 items-center gap-3 px-4 pb-2 pt-4"
            onContextMenu={(event) => {
              event.preventDefault();
              openCurrentMenu(event.clientX, event.clientY);
            }}
          >
            {cover ? (
              <img src={cover} alt="" className="size-22 shrink-0 rounded-xl object-cover" />
            ) : (
              <div className="grid size-22 shrink-0 place-items-center rounded-xl bg-white/[0.06]">
                <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold leading-5 text-primary">{song.title}</p>
              <p className="mt-1 truncate text-xs leading-4 text-primary-dark">
                {song.artists.map((artist, artistIndex) => (
                  <span key={`${artist.id}-${artist.name}-${artistIndex}`}>
                    {artistIndex > 0 && ", "}
                    {artist.id ? (
                      <button
                        type="button"
                        onClick={() => send({ kind: "open-main", href: `/artist/${artist.id}` })}
                        className="cursor-pointer hover:text-primary hover:underline"
                      >
                        {artist.name}
                      </button>
                    ) : (
                      artist.name
                    )}
                  </span>
                ))}
              </p>
              <p className="mt-0.5 truncate text-[11px] leading-4 text-primary-dark/80">
                {song.album?.name && song.album.id ? (
                  <button
                    type="button"
                    onClick={() => send({ kind: "open-main", href: `/album/${song.album?.id}` })}
                    className="cursor-pointer hover:text-primary hover:underline"
                  >
                    {song.album.name}
                  </button>
                ) : (
                  song.album?.name
                )}
                {song.album?.name && song.year ? " • " : null}
                {song.year ?? null}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <RatingButtons
                likeStatus={song.likeStatus ?? "INDIFFERENT"}
                pending={state.ratingPending}
                size="sm"
                onRate={(rating) => send({ kind: "rate", rating })}
              />
            </div>
          </div>
          <PopoutProgress position={position} duration={duration} onSeek={(seconds) => send({ kind: "seek", position: seconds })} />

          <div className="flex shrink-0 items-center justify-center gap-2 py-3">
            <IconButton
              iconClass="icon-[solar--shuffle-linear]"
              label="Shuffle"
              size="sm"
              tone={shuffle ? "active" : "ghost"}
              iconScale="secondary"
              onClick={() => send({ kind: "toggle-shuffle" })}
            />
            <IconButton
              iconClass="icon-[solar--skip-previous-bold]"
              label="Previous"
              size="md"
              tone="ghost"
              iconScale="transport"
              onClick={() => send({ kind: "previous" })}
            />
            <IconButton
              iconClass={playing ? "icon-[solar--pause-bold]" : "icon-[solar--play-bold]"}
              label={playing ? "Pause" : "Play"}
              size="md"
              tone="solid"
              iconScale="transport"
              className="size-11"
              onClick={() => send({ kind: playing ? "pause" : "play" })}
            />
            <IconButton
              iconClass="icon-[solar--skip-next-bold]"
              label="Next"
              size="md"
              tone="ghost"
              iconScale="transport"
              onClick={() => send({ kind: "next" })}
            />
            <IconButton
              iconClass={loop ? "icon-[solar--repeat-one-minimalistic-linear]" : "icon-[solar--repeat-linear]"}
              label="Repeat"
              size="sm"
              tone={loop ? "active" : "ghost"}
              iconScale="secondary"
              onClick={() => send({ kind: "toggle-loop" })}
            />
          </div>

          {availableTabs.length > 1 && (
            <div role="tablist" className="mx-2 mb-2 flex shrink-0 rounded-xl bg-white/[0.05] p-1">
              {availableTabs.map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === name}
                  onClick={() => setTab(name)}
                  className={cn(
                    "flex-1 cursor-pointer rounded-lg py-1.5 text-[11px] font-medium transition-colors",
                    activeTab === name ? "bg-white/10 text-primary" : "text-primary-dark hover:text-primary",
                  )}
                >
                  {LABELS[name]}
                </button>
              ))}
            </div>
          )}

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab === "queue" && (
              <PopoutQueue
                queue={queue}
                index={index}
                onPlay={(row) => send({ kind: "play-index", index: row })}
                onMenu={openMenu}
              />
            )}
            {activeTab === "lyrics" && lyrics && <LyricsPanel lyrics={lyrics} />}
            {activeTab === "related" && relatedId && (
              <RelatedPanel
                relatedId={relatedId}
                title={relatedTitle}
                currentVideoId={song.videoId}
                onPlay={(track) => send({ kind: "start-mix", track: trackToWatchTrack(track) })}
                onOpen={(href) => send({ kind: "open-main", href })}
              />
            )}
          </div>
        </>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="icon-[solar--music-notes-linear] text-4xl text-primary-dark/50" />
          <p className="text-sm font-medium text-primary">Nothing playing</p>
          <p className="text-xs leading-5 text-primary-dark">Start a song in the main window and it appears here.</p>
        </div>
      )}

      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onStartMix={() => send({ kind: "start-mix", track: menu.track })}
          onPlayNext={() => send({ kind: "play-next", track: menu.track })}
          onAddToQueue={() => send({ kind: "add-to-queue", track: menu.track })}
          addToPlaylistVideoIds={[menu.track.videoId]}
          playlists={playlists}
          recommendedPlaylists={recommendedPlaylists}
          recommendedPending={recommendedPending}
          onLoadRecommendations={() => void fetchRecommendedPlaylists()}
        />
      )}
    </div>
  );
};

/**
 * The seek bar. The track runs edge to edge so it reads as the panel's own
 * divider rather than a floating control; only the times keep the text gutter.
 */
export const PopoutProgress = ({
  position,
  duration,
  onSeek,
  showTimes = true,
}: {
  position: number;
  duration: number;
  onSeek: (seconds: number) => void;
  showTimes?: boolean;
}) => {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const shown = dragValue ?? position;
  const percent = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  return (
    <div className="shrink-0">
      {showTimes && (
        <div className="flex items-center justify-between px-4 pb-1 text-[10px] tabular-nums text-primary-dark/70">
          <span>{clock(shown)}</span>
          <span>{duration > 0 ? clock(duration) : "--:--"}</span>
        </div>
      )}
      <div className="relative h-[3px] w-full bg-white/10">
        <div className="absolute inset-y-0 left-0 bg-white/90" style={{ width: `${percent}%` }} />
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={1}
          value={shown}
          aria-label="Seek"
          onChange={(event) => setDragValue(Number(event.target.value))}
          onPointerUp={(event) => {
            const value = Number(event.currentTarget.value);
            setDragValue(null);
            onSeek(value);
          }}
          onPointerLeave={() => setDragValue(null)}
          className="absolute inset-x-0 -top-2.5 h-6 w-full cursor-pointer opacity-0"
        />
      </div>
    </div>
  );
};
