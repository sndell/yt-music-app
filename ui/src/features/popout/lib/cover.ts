import type { Thumbnail, Track } from "@/lib/api";

/** The largest cover a `Track` carries. Songs carry a list of sizes, not one. */
export const coverOf = (song: Track | null) => {
  let best: Thumbnail | null = null;
  for (const thumb of song?.thumbnails ?? []) {
    if (!thumb.url) continue;
    if (!best || (thumb.width ?? 0) > (best.width ?? 0)) best = thumb;
  }
  return best?.url;
};
