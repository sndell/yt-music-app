import { useState } from "react";
import { PyBridge } from "@/lib/api";

/**
 * Cover URL for a row, with an inline fallback when YouTube will not serve the
 * thumbnail. Python re-encodes it as a data URL; if that fails too, the icon
 * stays. The same URL is retried once, never twice.
 *
 * Five row components held a verbatim 14-line copy of this before.
 */
export const useInlineThumbnail = (thumbnailUrl: string | undefined) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [inlined, setInlined] = useState<{ from: string; url: string } | null>(null);
  const inlinedUrl = inlined && inlined.from === thumbnailUrl ? inlined.url : null;

  const onError = () => {
    if (!thumbnailUrl) return;
    if (inlined?.from === thumbnailUrl) {
      setFailedUrl(thumbnailUrl);
      return;
    }
    void PyBridge.inlineThumbnail(thumbnailUrl).then((result) => {
      if (result.success && typeof result.data === "string" && result.data.startsWith("data:")) {
        setInlined({ from: thumbnailUrl, url: result.data });
      } else {
        setFailedUrl(thumbnailUrl);
      }
    });
  };

  return {
    coverSrc: inlinedUrl ?? thumbnailUrl,
    showCover: Boolean(thumbnailUrl) && failedUrl !== thumbnailUrl,
    onError,
  };
};
