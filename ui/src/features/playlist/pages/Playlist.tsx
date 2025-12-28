import { useLayoutEffect, useState } from "react";
import { useParams } from "wouter";
import type { PlaylistDetails } from "@/lib/api";
import { hexToRgba } from "@/util/hex_to_rgba";
import { usePlaylist } from "../hooks/usePlaylist";

export const Playlist = () => {
  const { id } = useParams();
  const { fetchPlaylistItems } = usePlaylist();
  const [playlist, setPlaylist] = useState<PlaylistDetails | null>(null);

  useLayoutEffect(() => {
    if (!id) return;

    fetchPlaylistItems(id).then((data) => {
      console.log(data);

      if (data) setPlaylist(data);
    });
  }, [id, fetchPlaylistItems]);

  if (!playlist) {
    return (
      <div className="grid place-items-center py-8 h-full">
        <span className="icon-[svg-spinners--ring-resize] text-2xl text-primary-dark" />
      </div>
    );
  }

  const { title, description, thumbnails, author, year, trackCount, privacy, dominantColor } = playlist;
  const thumbnailUrl = thumbnails[0]?.url;

  const gradient = dominantColor
    ? `linear-gradient(to bottom, ${hexToRgba(dominantColor, 1)}, ${hexToRgba(dominantColor, 0.2)})`
    : undefined;

  const metadata = [author.name, year, `${trackCount} songs`, privacy.toString().toLowerCase()];

  return (
    <div>
      <div className="flex gap-6 items-end p-6" style={{ background: gradient }}>
        {thumbnailUrl && (
          <img
            src={thumbnailUrl}
            alt={title}
            className="size-48 shrink-0 rounded-md shadow-[0_0_24px_6px_rgba(0,0,0,0.35)]"
          />
        )}
        <div className="text-shadow-[7px_5px_8px_rgba(0,0,0,0.2)]">
          <h1 className="pt-1.5 text-5xl font-bold">{title}</h1>
          <p className="pt-1.5 font-medium text-primary-dark opacity-90">{description ?? "No description"}</p>
          <div className="flex gap-1.5 pt-3 font-medium text-primary-dark">
            {metadata.map((item, i) => (
              <span key={i} className={i === 0 ? "text-primary" : "capitalize"}>
                {i > 0 && <span className="mr-1.5">•</span>}
                {item}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
