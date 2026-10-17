/** Cover colour extraction, used by the queue's wash and the current row. */

import { useEffect, useState } from "react";
import { PyBridge, type WatchTrack } from "@/lib/api";

const colorCache = new Map<string, string | null>();

const saturationValue = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const saturation = max === 0 ? 0 : (max - min) / max;
  return [saturation * 100, max * 100] as const;
};

const toHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

export const parseHex = (hex: string) => {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!match) return null;
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] as const;
};

/**
 * Near-black covers disappear into the queue. Keep a real hue and raise it
 * enough to read. A few levels of channel noise on black is not a hue —
 * scaling it paints the row a color the cover does not have.
 */
export const readableAccent = (hex: string) => {
  const channels = parseHex(hex);
  if (!channels) return hex;
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  if (max >= 96) return hex;
  if (max === 0 || max - min < 24) return "#9a9a9a";
  const scale = 176 / max;
  return toHex(
    Math.min(255, Math.round(channels[0] * scale)),
    Math.min(255, Math.round(channels[1] * scale)),
    Math.min(255, Math.round(channels[2] * scale)),
  );
};

export const averageLuminance = (data: Uint8ClampedArray) => {
  let sum = 0;
  let count = 0;
  for (let index = 0; index < data.length; index += 16) {
    const red = data[index] / 255;
    const green = data[index + 1] / 255;
    const blue = data[index + 2] / 255;
    sum += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    count += 1;
  }
  return count === 0 ? 1 : sum / count;
};

/** Same saturation + value pick as playlist pages, weighted toward saturated swatches. */
const vibrantFromPixels = (data: Uint8ClampedArray) => {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (let index = 0; index < data.length; index += 4 * 6) {
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const a = data[index + 3];
    if (a < 200) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.n += 1;
    buckets.set(key, bucket);
  }

  let best: [number, number, number] | null = null;
  let bestScore = -1;
  let vibrant: [number, number, number] | null = null;
  let vibrantScore = -1;

  for (const bucket of [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 20)) {
    const rgb: [number, number, number] = [
      Math.round(bucket.r / bucket.n),
      Math.round(bucket.g / bucket.n),
      Math.round(bucket.b / bucket.n),
    ];
    const [saturation, value] = saturationValue(...rgb);
    const score = saturation + value;
    if (score > bestScore) {
      bestScore = score;
      best = rgb;
    }
    const chroma = Math.max(...rgb) - Math.min(...rgb);
    if (saturation >= 18 && chroma >= 24 && Math.max(...rgb) >= 40) {
      const weighted = saturation * 1.8 + value * 0.55;
      if (weighted > vibrantScore) {
        vibrantScore = weighted;
        vibrant = rgb;
      }
    }
  }

  const picked = vibrant ?? best;
  return picked ? toHex(...picked) : null;
};

const sampleCover = (url: string) =>
  new Promise<string | null>((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      const size = 48;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        resolve(null);
        return;
      }
      context.drawImage(image, 0, 0, size, size);
      try {
        resolve(vibrantFromPixels(context.getImageData(0, 0, size, size).data));
      } catch {
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = url;
  });

export const largestCover = (track: WatchTrack | null) => {
  const thumbs = track?.thumbnail ?? [];
  if (thumbs.length === 0) return undefined;
  return thumbs.reduce((best, thumb) => ((thumb.width ?? 0) > (best.width ?? 0) ? thumb : best)).url;
};

/** Near-black channel noise is not a usable accent. A real dark hue still is. */
const usableAccent = (hex: string | null | undefined) => {
  const channels = hex ? parseHex(hex) : null;
  if (!channels) return false;
  const max = Math.max(...channels);
  const min = Math.min(...channels);
  return max >= 40 || max - min >= 24;
};

export const useVibrantCover = (url: string | undefined, videoId: string | undefined, fallbackUrl?: string) => {
  const cacheKey = url ? `${url}|${videoId ?? ""}` : "";
  const cachedAtStart = cacheKey ? colorCache.get(cacheKey) : undefined;
  const [color, setColor] = useState<string | null>(usableAccent(cachedAtStart) ? (cachedAtStart ?? null) : null);

  useEffect(() => {
    if (!url) {
      setColor(null);
      return;
    }
    const cached = colorCache.get(cacheKey);
    if (usableAccent(cached)) {
      setColor(cached ?? null);
      return;
    }

    let cancelled = false;
    const finish = (value: string | null) => {
      colorCache.set(cacheKey, value);
      if (!cancelled) setColor(value);
    };

    void (async () => {
      const cover = await PyBridge.getCoverColor(url);
      if (cover.success && usableAccent(cover.data)) {
        finish(cover.data);
        return;
      }
      const fromCover = await sampleCover(url);
      if (usableAccent(fromCover)) {
        finish(fromCover);
        return;
      }
      // The largest thumb is often a host that blocks pixel reads. A data-URL
      // thumb of the same art can still be sampled.
      if (fallbackUrl && fallbackUrl !== url) {
        const fromFallback = await sampleCover(fallbackUrl);
        if (usableAccent(fromFallback)) {
          finish(fromFallback);
          return;
        }
      }
      // Some cover hosts block pixel reads. The video poster is the same art and can be sampled.
      if (videoId) {
        const fromPoster = await sampleCover(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
        if (usableAccent(fromPoster)) {
          finish(fromPoster);
          return;
        }
      }
      finish(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [url, videoId, fallbackUrl, cacheKey]);

  return color;
};
