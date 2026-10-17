/** Relative luminance of a `#rrggbb` color, for picking readable text on it. */
const luminance = (color: string) => {
  const value = Number.parseInt(color.replace("#", ""), 16);
  if (!Number.isFinite(value)) return 0;
  const channels = [16, 8, 0].map((shift) => ((value >> shift) & 0xff) / 255);
  const [r, g, b] = channels.map((channel) =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/**
 * Dark text on the pale half of YouTube's tile palette, white on the rest.
 * The colors are the categories' own, so the tile has to decide per color;
 * white on a pale yellow tile is unreadable.
 */
export const tileTextClass = (color: string) => (luminance(color) > 0.45 ? "text-black/85" : "text-white");
