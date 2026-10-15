import { useState } from "react";
import { IconButton } from "@/components/ui/IconButton";
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
}: {
  onPlay?: () => void;
  onShuffle?: () => void;
  shuffleMenu?: ShuffleMenuOptions;
  /** Outlined controls, same treatment as Shuffle. Playlist adds like + edit here. */
  extra?: PlaybackExtraAction | PlaybackExtraAction[];
  /** Kept so existing call sites compile. Both values render the same circular controls. */
  variant?: "pill" | "icon";
  className?: string;
}) => {
  const [menu, setMenu] = useState<{ x: number; y: number; trigger: HTMLElement } | null>(null);
  const showShuffle = Boolean(onShuffle || shuffleMenu);

  if (!onPlay && !showShuffle && !extra) return null;

  return (
    <div className={cn("flex shrink-0 items-center gap-2", className)}>
      {onPlay && (
        <IconButton
          iconClass="icon-[solar--play-bold]"
          label="Play"
          size="md"
          tone="solid"
          iconScale="transport"
          onClick={onPlay}
        />
      )}
      {showShuffle && (
        <IconButton
          iconClass="icon-[solar--shuffle-linear]"
          label={shuffleMenu ? "Shuffle options" : "Shuffle"}
          size="sm"
          tone="outline"
          onClick={(event) => {
            if (!shuffleMenu) {
              onShuffle?.();
              return;
            }
            const trigger = event.currentTarget;
            const rect = trigger.getBoundingClientRect();
            setMenu((current) => (current ? null : { x: rect.left, y: rect.bottom + 6, trigger }));
          }}
        />
      )}
      {(extra ? (Array.isArray(extra) ? extra : [extra]) : []).map((option) => (
        <IconButton
          key={option.label}
          iconClass={option.iconClass}
          label={option.label}
          size="sm"
          tone={option.active ? "active" : "outline"}
          onClick={option.onClick}
        />
      ))}
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
    </div>
  );
};
