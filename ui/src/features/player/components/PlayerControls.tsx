/** Split out of Player.tsx. */

import type { MouseEvent } from "react";
import { Link, useLocation } from "wouter";

const followLink = (event: MouseEvent<HTMLAnchorElement>, href: string, navigate: (to: string) => void) => {
  event.preventDefault();
  event.stopPropagation();
  navigate(href);
};


const PLAYBAR_TITLE_CHARS = 30;
import { IconButton, type IconButtonSize } from "@/components/ui/IconButton";
import { ScrollingText } from "@/components/ui/ScrollingText";
import { cn } from "@/util/cn";
import type { LikeStatus, Track } from "@/lib/api/types";
import { VolumeControl } from "./VolumeControl";

export const RatingButtons = ({
  likeStatus,
  pending,
  onRate,
  size = "md",
}: {
  likeStatus: LikeStatus;
  pending: boolean;
  onRate: (rating: LikeStatus) => void;
  size?: IconButtonSize;
}) => (
  <>
    <IconButton
      iconClass={likeStatus === "LIKE" ? "icon-[solar--like-bold]" : "icon-[solar--like-linear]"}
      label="Like"
      size={size}
      tone="ghost"
      iconScale="secondary"
      disabled={pending}
      onClick={() => onRate("LIKE")}
    />
    <IconButton
      iconClass={likeStatus === "DISLIKE" ? "icon-[solar--dislike-bold]" : "icon-[solar--dislike-linear]"}
      label="Dislike"
      size={size}
      tone={likeStatus === "DISLIKE" ? "active" : "ghost"}
      iconScale="secondary"
      disabled={pending}
      onClick={() => onRate("DISLIKE")}
    />
  </>
);

export const PlayerControls = ({
  currentSong,
  volume,
  setVolume,
  onPlay,
  onPause,
  onNext,
  onPrevious,
  isPlaying,
  canNext,
  canPrevious,
  queueOpen,
  onToggleQueue,
  hasVideo,
  videoOpen,
  onToggleVideo,
  hasVisualizer,
  visualizerOpen,
  onToggleVisualizer,
  popoutOpen,
  onTogglePopout,
  shuffle,
  onToggleShuffle,
  loop,
  onToggleLoop,
  ratingPending,
  onRate,
}: {
  currentSong: Track;
  volume: number;
  setVolume: (volume: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
  isPlaying: boolean;
  canNext: boolean;
  canPrevious: boolean;
  queueOpen: boolean;
  onToggleQueue: () => void;
  hasVideo: boolean;
  videoOpen: boolean;
  onToggleVideo: () => void;
  hasVisualizer: boolean;
  visualizerOpen: boolean;
  onToggleVisualizer: () => void;
  popoutOpen: boolean;
  onTogglePopout: () => void;
  shuffle: boolean;
  onToggleShuffle: () => void;
  loop: boolean;
  onToggleLoop: () => void;
  ratingPending: boolean;
  onRate: (rating: LikeStatus) => void;
}) => {
  const likeStatus = currentSong.likeStatus ?? "INDIFFERENT";
  const [, navigate] = useLocation();
  const albumName = currentSong.album?.name;
  const albumId = currentSong.album?.id;
  const releaseYear = currentSong.year;
  const credits = (
    <>
      {currentSong.artists.map((artist, index) => (
        <span key={`${artist.id}-${artist.name}-${index}`}>
          {index > 0 && ", "}
          {artist.id ? (
            <Link
              href={`/artist/${artist.id}`}
              onClick={(event) => followLink(event, `/artist/${artist.id}`, navigate)}
              className="hover:underline"
            >
              {artist.name}
            </Link>
          ) : (
            artist.name
          )}
        </span>
      ))}
      {albumName && (
        <>
          {currentSong.artists.length > 0 && <span aria-hidden="true"> • </span>}
          {albumId ? (
            <Link
              href={`/album/${albumId}`}
              onClick={(event) => followLink(event, `/album/${albumId}`, navigate)}
              className="hover:underline"
            >
              {albumName}
            </Link>
          ) : (
            albumName
          )}
        </>
      )}
      {releaseYear && (
        <>
          {(currentSong.artists.length > 0 || albumName) && <span aria-hidden="true"> • </span>}
          <span>{releaseYear}</span>
        </>
      )}
    </>
  );

  // Playbar only: cap the text so a long title or credit list can't push the
  // like buttons toward the transport controls. The cap is a `ch` width, so it
  // still shrinks with the window. Below `md` the like buttons overlay the
  // title, so there the text stays fully responsive and does not scroll.
  const trackTitle = (capped: boolean) => (
    <>
      {capped ? (
        <ScrollingText maxChars={PLAYBAR_TITLE_CHARS} reveal="self" className="text-sm text-primary">
          {currentSong.title}
        </ScrollingText>
      ) : (
        <span className="block truncate text-sm text-primary">{currentSong.title}</span>
      )}
      {capped ? (
        <ScrollingText maxChars={PLAYBAR_TITLE_CHARS} reveal="self" className="text-sm text-primary-dark">
          {credits}
        </ScrollingText>
      ) : (
        <span className="block truncate text-sm text-primary-dark">{credits}</span>
      )}
    </>
  );

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] col-span-2 items-center">
      <div className="flex min-w-0 items-center">
        <div className="group/track relative flex w-fit max-w-full items-center gap-1.5">
          <img src={currentSong.thumbnails[0].url} alt="" className="h-12 w-12 shrink-0 rounded-md" />
          <div className="relative min-w-0 max-md:min-w-24">
            <div className="min-w-0 max-md:hidden">{trackTitle(true)}</div>
            <div
              className={cn(
                "hidden min-w-0 transition-opacity duration-200 ease-out max-md:block",
                "group-hover/track:opacity-0 group-focus-within/track:opacity-0"
              )}
            >
              {trackTitle(false)}
            </div>
            <div
              className={cn(
                "pointer-events-none absolute inset-y-0 left-0 z-10 hidden translate-x-4 items-center gap-1 opacity-0 transition-[opacity,translate] duration-200 ease-out max-md:flex",
                "group-hover/track:pointer-events-auto group-hover/track:translate-x-0 group-hover/track:opacity-100",
                "group-focus-within/track:pointer-events-auto group-focus-within/track:translate-x-0 group-focus-within/track:opacity-100"
              )}
            >
              <RatingButtons likeStatus={likeStatus} pending={ratingPending} onRate={onRate} />
            </div>
          </div>
          <div className="flex items-center gap-1 pl-3 max-md:hidden">
            <RatingButtons likeStatus={likeStatus} pending={ratingPending} onRate={onRate} />
          </div>
        </div>
      </div>
      <div className="flex gap-1 items-center">
        <IconButton
          iconClass="icon-[solar--skip-previous-bold]"
          label="Previous"
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onPrevious}
          disabled={!canPrevious}
        />
        <IconButton
          iconClass={isPlaying ? "icon-[solar--pause-bold]" : "icon-[solar--play-bold]"}
          label={isPlaying ? "Pause" : "Play"}
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={isPlaying ? onPause : onPlay}
        />
        <IconButton
          iconClass="icon-[solar--skip-next-bold]"
          label="Next"
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onNext}
          disabled={!canNext}
        />
      </div>
      <div className="flex gap-1 items-center justify-self-end pr-3">
        <IconButton
          iconClass="icon-[solar--shuffle-linear]"
          label="Shuffle"
          size="md"
          tone={shuffle ? "active" : "ghost"}
          iconScale="transport"
          onClick={onToggleShuffle}
        />
        <IconButton
          iconClass={loop ? "icon-[solar--repeat-one-minimalistic-linear]" : "icon-[solar--repeat-linear]"}
          label="Loop"
          size="md"
          tone={loop ? "active" : "ghost"}
          iconScale="transport"
          onClick={onToggleLoop}
        />
        <VolumeControl volume={volume} setVolume={setVolume} />
        {hasVideo && (
          <IconButton
            iconClass="icon-[solar--video-frame-linear]"
            label={videoOpen ? "Hide video" : "Show video"}
            size="md"
            tone={videoOpen ? "active" : "ghost"}
            iconScale="dense"
            onClick={onToggleVideo}
          />
        )}
        {hasVisualizer && (
          <IconButton
            iconClass="icon-[solar--soundwave-linear]"
            label={visualizerOpen ? "Hide visualizer" : "Show visualizer"}
            size="md"
            tone={visualizerOpen ? "active" : "ghost"}
            iconScale="dense"
            onClick={onToggleVisualizer}
          />
        )}
        <IconButton
          iconClass="icon-[lucide--picture-in-picture-2]"
          label={popoutOpen ? "Close the player popout" : "Open the player popout"}
          size="md"
          tone={popoutOpen ? "active" : "ghost"}
          iconScale="dense"
          onClick={onTogglePopout}
        />
        <IconButton
          iconClass={cn(
            "icon-[solar--alt-arrow-up-bold] transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
            queueOpen && "rotate-180 translate-y-[1.5px]"
          )}
          label={queueOpen ? "Close queue" : "Show queue"}
          size="md"
          tone="ghost"
          iconScale="transport"
          onClick={onToggleQueue}
          className={queueOpen ? "text-primary" : undefined}
        />
      </div>
    </div>
  );
};
