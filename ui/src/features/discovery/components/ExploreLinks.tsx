import { Link } from "wouter";
import { cn } from "@/util/cn";

type ExploreLink = {
  href: string;
  title: string;
  blurb: string;
  icon: string;
  /** The card's own wash; the pair reads as two destinations, not one list. */
  surface: string;
};

const LINKS: ExploreLink[] = [
  {
    href: "/moods",
    title: "Moods & genres",
    blurb: "Find something for the moment, from chill to workout",
    icon: "icon-[solar--widget-5-linear]",
    surface: "from-[oklch(0.42_0.1_305)] to-[oklch(0.2_0.03_305)]",
  },
  {
    href: "/charts",
    title: "Charts",
    blurb: "See what is topping the charts around the world",
    icon: "icon-[solar--chart-2-linear]",
    surface: "from-[oklch(0.45_0.14_27)] to-[oklch(0.2_0.03_27)]",
  },
];

/**
 * The two pages Explore leads to, as cards rather than sidebar items. Each card
 * is a link, so the back button returns to the feed while the opened page keeps
 * its own route (the charts country lives in the URL).
 */
export const ExploreLinks = () => (
  <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
    {LINKS.map((link) => (
      <Link
        key={link.href}
        href={link.href}
        aria-label={`Open ${link.title}`}
        className={cn(
          "group relative flex min-h-40 flex-col justify-between overflow-hidden rounded-2xl bg-linear-to-br p-5 text-white",
          link.surface,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -right-4 -bottom-7 text-[7rem] text-white/10 transition-transform duration-300 ease-out group-hover:scale-110",
            link.icon,
          )}
        />
        <span className="relative flex flex-col gap-1">
          <span className="text-xl font-bold">{link.title}</span>
          <span className="max-w-[85%] text-sm text-white/70">{link.blurb}</span>
        </span>
        <span className="relative flex items-center gap-1 text-sm font-medium text-white/80 group-hover:text-white">
          Browse
          <span
            aria-hidden="true"
            className="icon-[solar--alt-arrow-right-linear] transition-transform duration-200 group-hover:translate-x-0.5"
          />
        </span>
      </Link>
    ))}
  </div>
);
