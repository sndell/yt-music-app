/** Helpers the Home shelves and the quick picks both use. */

import type { HomeItem } from "@/lib/api";

export const itemKey = (item: HomeItem, index: number) =>
  `${item.kind}-${item.videoId ?? item.browseId ?? item.playlistId ?? index}`;

export const albumOpenId = (item: HomeItem) => {
  if (item.kind !== "album") return null;
  if (item.browseId) return item.browseId;
  if (item.playlistId?.startsWith("OLAK5uy_")) return item.playlistId;
  return null;
};
