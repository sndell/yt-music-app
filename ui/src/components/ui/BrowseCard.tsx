import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { Thumbnail } from "@/lib/api/types";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";

export const BrowseCard = ({
  href,
  title,
  subtitle,
  explicit = false,
  thumbnails,
}: {
  href: string;
  title: string;
  subtitle?: string | null;
  explicit?: boolean;
  thumbnails: Thumbnail[];
}) => {
  const [failed, setFailed] = useState(false);
  const thumbnailUrl = thumbnails?.[0]?.url;
  const detail = subtitle?.trim();

  return (
    <Link href={href} aria-label={`Open ${title}`} className="group w-36 shrink-0 sm:w-40">
      <div className="relative aspect-square overflow-hidden rounded-md bg-secondary">
        {thumbnailUrl && !failed ? (
          <img src={thumbnailUrl} alt="" onError={() => setFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <span className="icon-[solar--music-note-linear] text-2xl text-primary-dark" />
          </span>
        )}
        <span className={mediaScrimClass}>
          <RevealIcon iconClassName="icon-[solar--library-linear] text-3xl" />
        </span>
      </div>
      <span className="mt-2 block w-full text-left">
        <span title={title} className="block truncate text-sm font-medium">
          {title}
        </span>
        {(detail || explicit) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-primary-dark">
            {explicit && (
              <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[3px] border border-current text-[9px] leading-none">
                E
              </span>
            )}
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
  <section className="px-6 pb-8">
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-xl font-bold">{title}</h2>
      {action}
    </div>
    {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    <div className="mt-3 flex w-full gap-3 overflow-x-auto pb-1 scrollbar-thin">{children}</div>
  </section>
);
