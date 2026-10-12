import { hexToRgba } from "@/util/hex_to_rgba";

export const collectionTitleClass = "mt-1.5 line-clamp-2 min-w-0 max-w-full text-3xl font-bold wrap-break-word @2xl:text-4xl";
export const collectionCoverClass = "size-36 shrink-0 @2xl:size-44";
export const collectionHeaderClass = "flex flex-col gap-4 p-5 @lg:flex-row @lg:items-start @lg:gap-6";

/** Color stays in the header and is gone by its bottom edge. The list only keeps a short hint. */
export const collectionWash = (color: string | null | undefined) => {
  if (!color) return { header: "transparent", tracks: "transparent" };
  return {
    header: `linear-gradient(to bottom, ${hexToRgba(color, 1)}, ${hexToRgba(color, 0.2)})`,
    tracks: `linear-gradient(to bottom, ${hexToRgba(color, 0.1)}, transparent)`,
  };
};
