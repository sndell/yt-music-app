import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { PyBridge, type RelatedItem, type RelatedItemKind, type RelatedSection, type Track } from "@/lib/api";
import { CoverFrame } from "@/components/ui/CoverFrame";
import { ExplicitBadge } from "@/components/ui/ExplicitBadge";
import { RevealIcon, mediaScrimClass } from "@/components/ui/RevealIcon";
import { cn } from "@/util/cn";
import { usePlayer } from "../context/PlayerContext";

/** The glyph over a row's cover: a song plays, every other kind opens a page. */
const ROW_ICON: Record<RelatedItemKind, string> = {
  song: "icon-[solar--play-bold]",
  album: "icon-[solar--album-linear]",
  playlist: "icon-[solar--playlist-linear]",
  artist: "icon-[solar--user-linear]",
  text: "",
};

/** YouTube's title for the song carousel. The panel heading already says the
 * panel is related to this song, so that second label is dropped. */
const HIDDEN_SECTION_TITLES = new Set(["you might also like"]);

const toTrack = (item: RelatedItem): Track => ({
  videoId: item.videoId ?? "",
  title: item.title,
  artists: item.artists ?? [],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: item.thumbnails ?? [],
  isAvailable: true,
  isExplicit: item.explicit,
  videoType: item.videoType ?? "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "",
  durationSeconds: 0,
  setVideoId: "",
});

const RelatedRow = ({ item, playing, onActivate }: { item: RelatedItem; playing: boolean; onActivate: () => void }) => (
  <button
    type="button"
    onClick={onActivate}
    aria-label={`${item.kind === "song" ? "Play" : "Open"} ${item.title}`}
    className={cn(
      "group flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg p-1.5 text-left transition-colors hover:bg-primary-light",
      playing && "bg-primary-light",
    )}
  >
    <CoverFrame
      thumbnails={item.thumbnails}
      shape={item.kind === "artist" ? "round" : "square"}
      size="md"
      className="bg-primary-light"
    >
      <span className={mediaScrimClass}>
        <RevealIcon iconClassName={cn(ROW_ICON[item.kind], "text-lg")} />
      </span>
    </CoverFrame>
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm font-medium">{item.title}</span>
        {item.explicit && <ExplicitBadge />}
      </span>
      {item.subtitle && <span className="block truncate text-xs text-primary-dark">{item.subtitle}</span>}
    </span>
  </button>
);

/**
 * YouTube Music's Related tab for the queue's song. The id is the `related`
 * browse id the asker already has from the watch playlist response, so opening
 * this panel costs the one `get_song_related` read and nothing else. The title
 * comes from that same response and names the song, so the panel stays honest
 * after Next moves the player to a different track.
 *
 * A failed read raises in Python and lands here as an error with a retry; an
 * answer of no sections is the empty state, and the two never share a face. The
 * request id is captured before the call and compared when it resolves, because
 * a flag cleared by the effect can be re-armed before the answer lands.
 */
export const RelatedPanel = ({ relatedId, title }: { relatedId: string; title: string | null }) => {
  const [sections, setSections] = useState<RelatedSection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const requestIdRef = useRef(0);
  const [, navigate] = useLocation();
  const { currentSong, startMix } = usePlayer();

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    // A retry must be able to take the error down, or it outlives the sections
    // the retry fetched and hides them.
    setError(null);
    // A new id is a different song's set; nothing from the last one carries.
    setSections(null);
    void PyBridge.getSongRelated(relatedId).then((result) => {
      if (requestId !== requestIdRef.current) return;
      if (!result.success) {
        setError(result.error.message);
        return;
      }
      setSections(Array.isArray(result.data) ? result.data : []);
    });
    return () => {
      requestIdRef.current += 1;
    };
  }, [relatedId, revision]);

  const open = (item: RelatedItem) => {
    if (item.kind === "song" && item.videoId) {
      startMix(toTrack(item));
      return;
    }
    if (item.kind === "artist" && item.browseId) {
      navigate(`/artist/${item.browseId}`);
      return;
    }
    if (item.kind === "album") {
      const albumId = item.browseId ?? (item.playlistId?.startsWith("OLAK5uy_") ? item.playlistId : null);
      if (albumId) navigate(`/album/${albumId}`);
      return;
    }
    if (item.kind === "playlist" && item.playlistId) navigate(`/playlist/${item.playlistId}`);
  };

  const retry = () => setRevision((value) => value + 1);

  return (
    <div className="relative z-10 flex-1 min-h-0 overflow-y-auto px-1.5 pt-1 pb-2 scrollbar-thin [overflow-anchor:none] [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
      {error && (
        <p role="alert" className="px-1.5 py-8 text-sm text-red-400">
          {error}{" "}
          <button type="button" onClick={retry} className="cursor-pointer text-primary hover:underline">
            Try again
          </button>
        </p>
      )}

      {!error && sections === null && (
        <div className="grid place-items-center py-8" role="status" aria-label="Loading related songs">
          <span className="icon-[solar--loader-linear] animate-spin text-2xl text-primary-dark" />
        </div>
      )}

      {!error && sections !== null && sections.length === 0 && (
        <p className="px-1.5 py-8 text-sm text-center text-primary-dark">
          YouTube Music has no related songs for this one.{" "}
          <button type="button" onClick={retry} className="cursor-pointer text-primary hover:underline">
            Reload
          </button>
        </p>
      )}

      {!error && sections !== null && sections.length > 0 && title && (
        <p className="truncate px-1.5 pt-1 pb-0.5 text-sm font-semibold" title={`Related to ${title}`}>
          Related to {title}
        </p>
      )}

      {!error &&
        sections?.map((section) => (
          <section key={section.title} className="pb-1">
            {!HIDDEN_SECTION_TITLES.has(section.title.trim().toLowerCase()) && (
              <p className="px-1.5 pt-1.5 pb-1 text-xs font-semibold text-primary-dark">{section.title}</p>
            )}
            {section.items.map((item, index) =>
              item.kind === "text" ? (
                <p key={`text-${index}`} className="px-1.5 py-1 text-xs leading-relaxed text-primary-dark">
                  {item.title}
                </p>
              ) : (
                <RelatedRow
                  key={item.videoId ?? item.browseId ?? item.playlistId ?? index}
                  item={item}
                  playing={Boolean(item.videoId) && item.videoId === currentSong?.videoId}
                  onActivate={() => open(item)}
                />
              ),
            )}
          </section>
        ))}
    </div>
  );
};
