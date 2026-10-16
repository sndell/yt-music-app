import { PyBridge, type LyricLine } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/util/cn";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { playhead } from "../lib/playhead";
import type { SongLyrics } from "../context/PlayerContext";
import { LanguageMenu } from "./LanguageMenu";
import { languageName } from "../lib/languages";

/** Index of the line playing at `seconds`, or -1 before the first one starts. */
const lineAt = (lines: LyricLine[], seconds: number) => {
  const ms = seconds * 1000;
  let active = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startMs > ms) break;
    active = index;
  }
  return active;
};

/**
 * The line playing right now.
 *
 * Reads the playback clock through `useSyncExternalStore`, so a playback tick
 * re-renders only when the highlighted line changes rather than several times
 * a second. Songs without timings have no lines and stay at -1.
 */
const useActiveLine = (lines: LyricLine[]) => {
  const subscribe = useCallback(
    (notify: () => void) => (lines.length === 0 ? () => {} : playhead.subscribe(notify)),
    [lines]
  );
  const getSnapshot = useCallback(() => (lines.length === 0 ? -1 : lineAt(lines, playhead.get())), [lines]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * The Lyrics tab of the queue panel, for the resolved playing song.
 *
 * YouTube Music returns timings for some songs and a plain block for others, so
 * the timed view highlights the playing line and the plain view is shown as is.
 * A timed line is a play position too: clicking one seeks the song to it. The
 * translate button asks Python for a copy in the picked language, which carries
 * the original's timings, and swaps it in until it is pressed again.
 */
export const LyricsPanel = ({ lyrics }: { lyrics: SongLyrics }) => {
  const [translation, setTranslation] = useState<SongLyrics & { target: string } | null>(null);
  const [pending, setPending] = useState<{ videoId: string; target: string } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuCloseRef = useRef(0);
  const videoIdRef = useRef(lyrics.videoId);
  const { showToast } = useToast();

  // The panel is reused for the next song, so the click handler needs the id the
  // player is on when its answer lands, not the one it started from.
  useEffect(() => {
    videoIdRef.current = lyrics.videoId;
  }, [lyrics.videoId]);

  // A translation belongs to the song it was asked for, so the panel shows the
  // original again once the player has moved on.
  const translated = translation?.videoId === lyrics.videoId ? translation : null;
  const translating = pending?.videoId === lyrics.videoId;
  const shown = (translated as SongLyrics | null) ?? lyrics;
  const lines = shown.lines;
  const active = useActiveLine(lines);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLParagraphElement>(null);

  // Keep the playing line in the middle of the panel as playback moves. The
  // language menu listens for scrolls to dismiss itself, so while it is open
  // the follow pauses; otherwise one programmatic scroll shut it again.
  useEffect(() => {
    const list = listRef.current;
    const line = activeRef.current;
    if (active < 0 || menuOpen || !list || !line) return;
    const target = line.offsetTop - list.clientHeight / 2 + line.clientHeight / 2;
    list.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [active, menuOpen]);

  const translateTo = async (target: string) => {
    if (translated?.target === target) return;
    const videoId = lyrics.videoId;
    setPending({ videoId, target });
    const result = await PyBridge.translateLyrics(videoId, target);
    setPending((current) => (current?.videoId === videoId ? null : current));
    if (videoIdRef.current !== videoId) return;
    const data = result.success ? result.data : null;
    if (data?.translated && data.lyrics) {
      setTranslation({
        videoId,
        target,
        text: data.lyrics,
        source: data.source ?? null,
        lines: data.lines ?? [],
      });
      return;
    }
    // A song already in the target language comes back with the detected source
    // language, which doubles as the "nothing to do" explanation.
    const detectedName = languageName(data?.language);
    if (detectedName) {
      showToast(`These lyrics are already in ${detectedName}`);
      return;
    }
    showToast("Could not translate these lyrics", "error");
  };

  const selectLanguage = (code: string | null) => {
    if (code === null) {
      setTranslation(null);
      return;
    }
    void translateTo(code);
  };

  const openMenu = (element: HTMLButtonElement) => {
    window.clearTimeout(menuCloseRef.current);
    setMenuAnchor(element);
    setMenuOpen(true);
  };

  const closeMenu = () => {
    setMenuOpen(false);
    window.clearTimeout(menuCloseRef.current);
    // The anchor survives the close animation, then drops.
    menuCloseRef.current = window.setTimeout(() => setMenuAnchor(null), 200);
  };

  useEffect(() => () => window.clearTimeout(menuCloseRef.current), []);

  // The source of the words can sit left of the translate button, which
  // already shows the language a translation is in.
  const shownLanguage = translated ? (languageName(translated.target) ?? translated.target) : null;

  return (
    <div className="relative z-10 flex flex-1 flex-col min-h-0">
      <div className="flex shrink-0 items-center justify-end gap-2 px-4 pt-2 [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]">
        {shown.source && (
          <span className="mr-auto flex min-w-0 items-center gap-2 text-xs text-primary-dark">
            <span className="truncate">{shown.source}</span>
          </span>
        )}
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={translating}
          onPointerDown={(event) => {
            event.preventDefault();
            if (menuAnchor) closeMenu();
            else openMenu(event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            if (menuAnchor) closeMenu();
            else openMenu(event.currentTarget);
          }}
          className={cn(
            "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors duration-200 disabled:cursor-default",
            translated ? "bg-white/10 text-primary" : "text-primary-dark hover:bg-white/5 hover:text-primary"
          )}
        >
          <span
            className={cn(
              "text-sm",
              translating ? "icon-[solar--loader-linear] animate-spin" : "icon-[solar--translation-linear]"
            )}
          />
          {translating ? "Translating…" : (shownLanguage ?? "Translate")}
          <span
            className={cn(
              "text-sm transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] icon-[solar--alt-arrow-down-linear]",
              menuOpen && "rotate-180"
            )}
          />
        </button>
      </div>
      {menuAnchor && (
        <LanguageMenu
          open={menuOpen}
          trigger={menuAnchor}
          activeCode={translated?.target ?? null}
          onSelect={selectLanguage}
          onClose={closeMenu}
        />
      )}
      <div
        ref={listRef}
        className="relative overflow-y-auto flex-1 min-h-0 px-4 py-3 scrollbar-thin [text-shadow:0_1px_3px_rgb(0_0_0/0.6)]"
      >
        {lines.length > 0 ? (
          <div className="pb-4">
            {lines.map((line, index) => (
              <p
                key={index}
                ref={index === active ? activeRef : undefined}
                onClick={() => playhead.seek(line.startMs / 1000)}
                className={cn(
                  // White and bold against dimmed lines: the two panel text tokens
                  // are only 0.15 lightness apart, which the highlight cannot carry.
                  "group relative text-[15px] leading-7 transition-[color,opacity,font-weight] duration-300",
                  index === active
                    ? "font-semibold text-white"
                    : "text-primary-dark opacity-50 hover:opacity-100 hover:text-primary"
                )}
              >
                {/* A line click seeks the song here; the glyph marks every line as a play position. */}
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 -left-3.5 -translate-y-1/2 text-[11px] text-primary opacity-0 transition-opacity duration-200 group-hover:opacity-100 icon-[solar--play-bold]"
                />
                {line.text}
              </p>
            ))}
          </div>
        ) : (
          <p className="text-[15px] leading-7 whitespace-pre-line text-primary">{shown.text}</p>
        )}
      </div>
    </div>
  );
};
