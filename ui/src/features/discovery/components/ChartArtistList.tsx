import { Link } from "wouter";
import type { ChartArtist } from "@/lib/api/types";
import { CoverFrame } from "@/components/ui/CoverFrame";
import { cn } from "@/util/cn";

const TREND_ICON = {
  up: "icon-[solar--alt-arrow-up-linear]",
  down: "icon-[solar--alt-arrow-down-linear]",
  neutral: "icon-[solar--minus-linear]",
} as const;

const TREND_LABEL = { up: "Moving up", down: "Moving down", neutral: "Steady" } as const;

/**
 * The top-artist chart: one row per artist in YouTube's rank order, carrying
 * the number YouTube prints beside it and its own trend arrow. An unranked
 * read sends neither, so the row still lists without them.
 */
export const ChartArtistList = ({ artists }: { artists: ChartArtist[] }) => (
  <ol className="flex flex-col">
    {artists.map((artist) => (
      <li key={artist.browseId}>
        <Link
          href={`/artist/${artist.browseId}`}
          aria-label={`Open ${artist.name}`}
          className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-primary-light"
        >
          <span
            className="w-6 shrink-0 text-right text-sm tabular-nums text-primary-dark"
            aria-label={artist.rank ? `Rank ${artist.rank}` : "Unranked"}
          >
            {artist.rank ?? ""}
          </span>
          <CoverFrame thumbnails={artist.thumbnails} shape="round" size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{artist.name}</span>
            {artist.subscribers && (
              <span className="block truncate text-xs text-primary-dark">{artist.subscribers} subscribers</span>
            )}
          </span>
          {artist.trend && (
            <span
              className={cn("shrink-0 text-sm text-primary-dark", TREND_ICON[artist.trend])}
              title={TREND_LABEL[artist.trend]}
              role="img"
              aria-label={TREND_LABEL[artist.trend]}
            />
          )}
        </Link>
      </li>
    ))}
  </ol>
);
