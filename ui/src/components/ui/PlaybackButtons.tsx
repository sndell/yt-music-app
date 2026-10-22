import { useState } from "react";
import { ShuffleMenu } from "@/components/ui/ShuffleMenu";
import { cn } from "@/util/cn";

/** When set, one or more outlined controls render after Shuffle. */
export type PlaybackExtraAction = {
  label: string;
  /** Full Iconify class, e.g. `icon-[solar--soundwave-linear]`. */
  iconClass: string;
  onClick: () => void;
  /** Marks the toggle as engaged, e.g. a filled heart. */
  active?: boolean;
};

/** When set, the Shuffle control opens a menu with both ways to start. */
export type ShuffleMenuOptions = {
  onShuffle: () => void;
  onTrueShuffle: () => void;
};

export const PlaybackButtons = ({
  onPlay,
  onShuffle,
  shuffleMenu,
  extra,
  className,
  variant = "pill",
}: {
  onPlay?: () => void;
  onShuffle?: () => void;
  shuffleMenu?: ShuffleMenuOptions;
  /** Controls beside Shuffle. Playlist adds like + edit here. */
  extra?: PlaybackExtraAction | PlaybackExtraAction[];
  /** `icon` renders the compact row the sticky bar uses. */
  variant?: "pill" | "icon";
  className?: string;
}) => {
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null);
  const showShuffle = Boolean(onShuffle || shuffleMenu);
  const compact = variant === "icon";
  const extras = extra ? (Array.isArray(extra) ? extra : [extra]) : [];

  if (!onPlay && !showShuffle && extras.length === 0) return null;

  return (
    <>
      <div className={cn("flex shrink-0 items-center", compact ? "gap-2" : "gap-3", className)}>
        {onPlay && (
          <button
            type="button"
            onClick={onPlay}
            aria-label="Play"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center bg-white font-semibold text-black transition-colors duration-200 hover:bg-white/90",
              compact
                ? "size-8 rounded-full"
                : "h-12 gap-2.5 rounded-full px-6 text-sm font-bold tracking-[0.09em] uppercase",
            )}
          >
            <span className={cn("icon-[solar--play-bold]", compact ? "text-sm" : "text-lg")} />
            {!compact && "Play"}
          </button>
        )}
        {showShuffle && (
          <button
            type="button"
            aria-label={shuffleMenu ? "Shuffle options" : "Shuffle"}
            onClick={(event) => {
              if (!shuffleMenu) {
                onShuffle?.();
                return;
              }
              const trigger = event.currentTarget;
              const rect = trigger.getBoundingClientRect();
              setMenu((current) => (current ? null : { x: rect.left, y: rect.bottom + 6, trigger }));
            }}
            className={cn(
              "grid cursor-pointer place-items-center rounded-full border backdrop-blur-md transition-colors duration-200",
              compact
                ? "size-8 border-transparent bg-transparent text-primary-dark hover:bg-white/10 hover:text-primary"
                : "size-11 border-white/25 bg-black/20 text-white hover:bg-white/15",
            )}
          >
            <span className={cn("icon-[solar--shuffle-linear]", compact ? "text-base" : "text-lg")} />
          </button>
        )}
        {extras.map((option) => (
          <button
            key={option.label}
            type="button"
            aria-label={option.label}
            onClick={option.onClick}
            className={cn(
              "grid cursor-pointer place-items-center rounded-full border backdrop-blur-md transition-colors duration-200",
              compact
                ? cn(
                    "size-8 border-transparent bg-transparent hover:bg-white/10",
                    option.active ? "text-primary" : "text-primary-dark hover:text-primary",
                  )
                : cn(
                    "size-11",
                    option.active
                      ? "border-transparent bg-white text-black hover:bg-white/90"
                      : "border-white/25 bg-black/20 text-white hover:bg-white/15",
                  ),
            )}
          >
            <span className={cn(option.iconClass, compact ? "text-base" : "text-lg")} />
          </button>
        ))}
      </div>
      {menu && shuffleMenu && (
        <ShuffleMenu
          x={menu.x}
          y={menu.y}
          trigger={menu.trigger}
          onClose={() => setMenu(null)}
          onShuffle={shuffleMenu.onShuffle}
          onTrueShuffle={shuffleMenu.onTrueShuffle}
        />
      )}
    </>
  );
};
