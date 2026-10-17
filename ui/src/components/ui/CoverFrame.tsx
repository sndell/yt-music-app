import type { ReactNode } from "react";
import type { Thumbnail } from "@/lib/api";
import { cn } from "@/util/cn";
import { useInlineThumbnail } from "@/components/ui/useInlineThumbnail";

const SQUARE_SIZES = {
  sm: "size-9",
  md: "size-10",
  lg: "size-11",
} as const;

/**
 * The artwork box for one row or card: the thumbnail, a data-URL fallback when
 * it will not load, or the fallback icon. Children render inside the box after
 * the image, which is where a play scrim goes.
 *
 * `shape` and `size` are the only differences the row components had in their
 * artwork boxes; a video cover is 16:9 and keeps one height.
 */
export const CoverFrame = ({
  thumbnails,
  fallbackIcon = "icon-[solar--music-note-linear]",
  shape = "square",
  size = "md",
  className,
  children,
}: {
  thumbnails: Thumbnail[] | null | undefined;
  fallbackIcon?: string;
  shape?: "square" | "round" | "video";
  size?: keyof typeof SQUARE_SIZES;
  className?: string;
  children?: ReactNode;
}) => {
  const { coverSrc, showCover, onError } = useInlineThumbnail(thumbnails?.[0]?.url);
  const box = shape === "video" ? "h-11 aspect-video" : SQUARE_SIZES[size];

  return (
    <span
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden bg-secondary",
        shape === "round" ? "rounded-full" : "rounded-md",
        box,
        className,
      )}
    >
      {showCover && coverSrc ? (
        <img
          src={coverSrc}
          alt=""
          draggable={false}
          onError={onError}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className={cn("text-primary-dark", fallbackIcon)} />
      )}
      {children}
    </span>
  );
};
