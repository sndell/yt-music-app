import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { PyBridge } from "@/lib/api";
import type { Thumbnail } from "@/lib/api/types";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { SnapRow } from "@/components/ui/SnapRow";
import { cn } from "@/util/cn";

export const BrowseCard = ({
  href,
  title,
  subtitle,
  explicit = false,
  thumbnails,
  shape = "square",
  iconClass = "icon-[solar--library-linear]",
}: {
  href: string;
  title: string;
  subtitle?: string | null;
  explicit?: boolean;
  thumbnails: Thumbnail[];
  /** Artist cards are round; albums and playlists are square. */
  shape?: "square" | "circle";
  /** Glyph drawn over the cover on hover. */
  iconClass?: string;
}) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const thumbnailUrl = thumbnails?.[0]?.url;
  const inlinedUrl = inlined?.from === thumbnailUrl ? inlined.url : null;
  const coverSrc = inlinedUrl ?? thumbnailUrl;
  const showCover = Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl;
  const detail = subtitle?.trim();

  const handleCoverError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((result) => {
      if (result.success && typeof result.data === "string" && result.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: result.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return (
    <Link href={href} aria-label={`Open ${title}`} className="group w-36 shrink-0 sm:w-40">
      <div className={cn("relative aspect-square overflow-hidden bg-secondary", shape === "circle" ? "rounded-full" : "rounded-md")}>
        {showCover && coverSrc ? (
          <img
            src={coverSrc}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={handleCoverError}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
          </span>
        )}
        <span className={mediaScrimClass}>
          <RevealIcon iconClassName={cn(iconClass, "text-2xl")} />
        </span>
      </div>
      <span className="mt-2 block w-full text-left">
        <span title={title} className="block truncate text-sm font-medium">
          {title}
        </span>
        {(detail || explicit) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
            {explicit && <ExplicitBadge />}
            {detail && <span className="truncate">{detail}</span>}
          </span>
        )}
      </span>
    </Link>
  );
};

export const BrowseRow = ({
  title,
  action,
  error,
  children,
}: {
  title: string;
  action?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) => (
  <section className={cn("group/snap px-6 pb-8")}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xl font-bold">{title}</h2>
      {action}
    </div>
    {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    <SnapRow>{children}</SnapRow>
  </section>
);
