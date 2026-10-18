/** Split out of Home.tsx. */

import { useEffect, useRef, useState } from "react";
import type { HomeItem, HomeShelf } from "@/lib/api";
import { itemKey } from "./homeItem";
import { IconButton } from "@/components/ui/IconButton";
import { TrackRow } from "@/components/ui/TrackRow";
import { isVideoMedia } from "@/components/ui/mediaFrame";
import { cn } from "@/util/cn";
import { HomeSection } from "./HomeSection";

const PAGE_SIZE = 12;
const PAGE_SLIDE_FALLBACK_MS = 500;

type QuickPickSlide = {
  id: number;
  from: number;
  to: number;
  dir: 1 | -1;
};

export const QuickPicks = ({
  shelf,
  page,
  setPage,
  currentVideoId,
  isMenuTarget,
  onPlayAll,
  onOpen,
  onOpenMenu,
}: {
  shelf: HomeShelf;
  page: number;
  setPage: (value: number | ((value: number) => number)) => void;
  currentVideoId: string | undefined;
  isMenuTarget: (item: HomeItem) => boolean;
  onPlayAll: () => void;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
}) => {
  const pageCount = Math.max(1, Math.ceil(shelf.items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const [shownPage, setShownPage] = useState(currentPage);
  const [slide, setSlide] = useState<QuickPickSlide | null>(null);
  const slideSerialRef = useRef(0);
  const pendingPageRef = useRef<number | null>(null);
  const completedIdRef = useRef<number | null>(null);

  const itemsFor = (pageIndex: number) =>
    shelf.items.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE);

  const go = (direction: 1 | -1) => {
    const destination = pendingPageRef.current ?? slide?.to ?? shownPage;
    const target = Math.max(0, Math.min(pageCount - 1, destination + direction));
    if (target === destination) return;
    setPage(target);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pendingPageRef.current = null;
      setSlide(null);
      setShownPage(target);
      return;
    }
    if (slide) {
      pendingPageRef.current = target;
      return;
    }
    setSlide({
      id: ++slideSerialRef.current,
      from: shownPage,
      to: target,
      dir: direction,
    });
  };

  const finishSlide = (active: QuickPickSlide) => {
    if (completedIdRef.current === active.id) return;
    completedIdRef.current = active.id;
    const pending = pendingPageRef.current;
    pendingPageRef.current = null;
    const next = pending === null ? null : Math.max(0, Math.min(pageCount - 1, pending));
    if (next !== null && next !== active.to) {
      setShownPage(active.to);
      setSlide({
        id: ++slideSerialRef.current,
        from: active.to,
        to: next,
        dir: next > active.to ? 1 : -1,
      });
      return;
    }
    setShownPage(active.to);
    setSlide(null);
  };

  const finishSlideRef = useRef(finishSlide);
  useEffect(() => {
    finishSlideRef.current = finishSlide;
  });
  useEffect(() => {
    if (!slide) return;
    const active = slide;
    const timer = window.setTimeout(() => finishSlideRef.current(active), PAGE_SLIDE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  const grid = (pageIndex: number, className?: string) => (
    <QuickPickGrid
      className={className}
      items={itemsFor(pageIndex)}
      currentVideoId={currentVideoId}
      isMenuTarget={isMenuTarget}
      onOpen={onOpen}
      onOpenMenu={onOpenMenu}
    />
  );

  const shownItems = itemsFor(shownPage);

  return (
    <HomeSection
      title={shelf.title}
      art={shelf.items[0]?.thumbnails?.[0]?.url}
      actions={
        shelf.items.length > 0 ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPlayAll}
              className="flex cursor-pointer items-center gap-2 rounded-full border border-primary px-3 py-1.5 text-sm transition-colors hover:bg-primary-light"
            >
              Play all
            </button>
            <IconButton
              iconClass="icon-[solar--alt-arrow-left-linear]"
              label="Previous page"
              size="sm"
              tone="outline"
              disabled={currentPage === 0}
              onClick={() => go(-1)}
            />
            <IconButton
              iconClass="icon-[solar--alt-arrow-right-linear]"
              label="Next page"
              size="sm"
              tone="outline"
              disabled={currentPage >= pageCount - 1}
              onClick={() => go(1)}
            />
          </div>
        ) : null
      }
    >
      {(slide || shownItems.length > 0) && (
        <div className="mt-4 overflow-hidden">
          {slide ? (
            <div
              key={slide.id}
              onAnimationEnd={(event) => {
                if (event.target !== event.currentTarget) return;
                finishSlide(slide);
              }}
              className={cn(
                "pointer-events-none flex w-[200%] items-start",
                slide.dir === 1 ? "animate-qp-next" : "animate-qp-prev"
              )}
            >
              {slide.dir === 1 ? (
                <>
                  {grid(slide.from, "w-1/2 shrink-0")}
                  {grid(slide.to, "w-1/2 shrink-0")}
                </>
              ) : (
                <>
                  {grid(slide.to, "w-1/2 shrink-0")}
                  {grid(slide.from, "w-1/2 shrink-0")}
                </>
              )}
            </div>
          ) : (
            grid(shownPage)
          )}
        </div>
      )}
    </HomeSection>
  );
};


export const QuickPickGrid = ({
  items,
  currentVideoId,
  isMenuTarget,
  onOpen,
  onOpenMenu,
  className,
}: {
  items: HomeItem[];
  currentVideoId: string | undefined;
  isMenuTarget: (item: HomeItem) => boolean;
  onOpen: (item: HomeItem) => void;
  onOpenMenu: (item: HomeItem, x: number, y: number) => void;
  className?: string;
}) => (
  <div className={cn("grid min-w-0 grid-cols-1 gap-x-6 gap-y-0.5 lg:grid-cols-2 xl:grid-cols-3", className)}>
    {items.map((item, index) => (
      <QuickPickRow
        key={itemKey(item, index)}
        item={item}
        playing={Boolean(item.videoId) && currentVideoId === item.videoId}
        menuOpen={isMenuTarget(item)}
        onPlay={() => onOpen(item)}
        onOpenMenu={(x, y) => onOpenMenu(item, x, y)}
      />
    ))}
  </div>
);


const QuickPickRow = ({
  item,
  playing,
  menuOpen,
  onPlay,
  onOpenMenu,
}: {
  item: HomeItem;
  playing: boolean;
  menuOpen: boolean;
  onPlay: () => void;
  onOpenMenu: (x: number, y: number) => void;
}) => (
  <div
    onContextMenu={(event) => {
      event.preventDefault();
      if (!item.videoId) return;
      onOpenMenu(event.clientX, event.clientY);
    }}
    className="min-w-0"
  >
    <TrackRow
      title={item.title}
      subtitle={item.subtitle}
      thumbnails={item.thumbnails}
      coverShape={isVideoMedia(item.videoType) ? "video" : "square"}
      coverSize="lg"
      density="compact"
      explicit={item.explicit}
      explicitOnSubtitle
      playing={playing}
      menuOpen={menuOpen}
      onActivate={onPlay}
    />
  </div>
);
