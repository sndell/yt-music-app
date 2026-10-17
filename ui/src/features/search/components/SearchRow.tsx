import type { SearchResult } from "@/lib/api";
import { TrackRow } from "@/components/ui/TrackRow";

const kindIcon = (kind: SearchResult["kind"]) => {
  if (kind === "artist" || kind === "profile") return "icon-[solar--user-linear]";
  return "icon-[solar--music-note-linear]";
};

const isRound = (kind: SearchResult["kind"]) => kind === "artist" || kind === "profile";

/** One compact search result row, shared by the sidebar flyout and the search page. */
export const SearchRow = ({
  result,
  onSelect,
  onOpenMenu,
  dense = false,
}: {
  result: SearchResult;
  onSelect: () => void;
  onOpenMenu?: (x: number, y: number) => void;
  dense?: boolean;
}) => (
  <TrackRow
    title={result.title}
    subtitle={result.subtitle}
    thumbnails={result.thumbnails}
    fallbackIcon={kindIcon(result.kind)}
    coverShape={isRound(result.kind) ? "round" : "square"}
    coverSize={dense ? "sm" : "md"}
    explicit={result.explicit}
    density={dense ? "compact" : "comfortable"}
    trailing={
      result.duration ? (
        <span className="shrink-0 text-xs text-primary-dark tabular-nums">{result.duration}</span>
      ) : null
    }
    onActivate={onSelect}
    onContextMenu={onOpenMenu}
    reveal={false}
  />
);
