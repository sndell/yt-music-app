import { Link } from "wouter";
import type { MoodCategory } from "@/lib/api/types";
import { cn } from "@/util/cn";
import { tileTextClass } from "../lib/tileColor";

/**
 * One Moods & genres category. YouTube Music draws a category as a solid color
 * tile with its name on it, and the payload carries that color, so the tile is
 * the category's image. A category without a color falls back to the app's
 * secondary surface.
 */
export const MoodTile = ({ category }: { category: MoodCategory }) => (
  <Link
    href={`/moods/${encodeURIComponent(category.params)}`}
    aria-label={`Open ${category.title}`}
    className="group w-36 shrink-0 sm:w-40"
  >
    <span
      className={cn(
        "relative flex aspect-square items-center justify-center overflow-hidden rounded-md p-3 text-center text-sm font-semibold transition-transform group-hover:scale-[1.02]",
        category.color ? tileTextClass(category.color) : "bg-secondary text-primary",
      )}
      style={category.color ? { backgroundColor: category.color } : undefined}
    >
      <span className="wrap-break-word">{category.title}</span>
    </span>
  </Link>
);
