import { useEffect, useRef } from "react";
import { usePlayer } from "../context/PlayerContext";
import { activeAudio } from "../lib/activeAudio";
import { loadYouTubeApi, type YouTubePlayer } from "../lib/youtube";

/** How often the picture is checked against the audio. */
const SYNC_POLL_MS = 1000;
/** A drift smaller than this stays; seeking every tick would stutter. */
const MAX_DRIFT_SECONDS = 0.4;

const PLAYER_VARS = {
  autoplay: 1,
  mute: 1,
  controls: 0,
  rel: 0,
  modestbranding: 1,
  playsinline: 1,
  origin: window.location.origin,
};

/**
 * The YouTube embed. It is muted, so the app's `<audio>` stays the sound. It is
 * clickable, so the YouTube title and link work, but the control bar is off
 * (`controls=0`): volume, progress, and settings are gone with it. Play and
 * pause come from the app's player bar, and both are mirrored either way.
 */
const YouTubeVideo = ({ videoId }: { videoId: string }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let player: YouTubePlayer | null = null;
    let poll = 0;

    const seekToAudio = () => {
      const audio = activeAudio();
      if (audio) player?.seekTo(audio.currentTime, true);
    };

    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return;
      player = new YT.Player(hostRef.current, {
        videoId,
        playerVars: PLAYER_VARS,
        events: {
          onReady: () => {
            readyRef.current = true;
            player?.mute();
            const audio = activeAudio();
            if (!audio || audio.paused) player?.pauseVideo();
            else player?.playVideo();
            seekToAudio();
            // Keep the picture on the audio while both play. A mismatch means
            // the user paused the embed, which already paused the audio, so
            // leave it be.
            poll = window.setInterval(() => {
              const node = activeAudio();
              if (!readyRef.current || !player || !node || node.paused) return;
              if (player.getPlayerState() !== 1) return;
              if (Math.abs(player.getCurrentTime() - node.currentTime) > MAX_DRIFT_SECONDS) {
                player.seekTo(node.currentTime, true);
              }
            }, SYNC_POLL_MS);
          },
          onStateChange: (event) => {
            const node = activeAudio();
            if (!node) return;
            // The user pressed play or pause on the embed; move the app with it.
            if (event.data === 2 && !node.paused) node.pause();
            else if (event.data === 1 && node.paused) void node.play().catch(() => {});
          },
        },
      });
      playerRef.current = player;
    });

    // Only the current song's element drives the picture: during a crossfade
    // the element on its way out is still playing and its events would fight
    // the incoming one for the embed.
    const onPlay = (event: Event) => {
      if (event.target === activeAudio()) playerRef.current?.playVideo();
    };
    const onPause = (event: Event) => {
      if (event.target === activeAudio()) playerRef.current?.pauseVideo();
    };
    const onSeeked = (event: Event) => {
      if (event.target === activeAudio()) seekToAudio();
    };
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pause", onPause, true);
    document.addEventListener("seeked", onSeeked, true);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pause", onPause, true);
      document.removeEventListener("seeked", onSeeked, true);
      readyRef.current = false;
      player?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  return <div ref={hostRef} />;
};

/**
 * The music video, drawn over the sidebar and the routed content on black. The
 * queue and the player bar stay put; the toggle in the player turns this on and
 * off. It is inset and rounded like the other panels.
 */
export const VideoOverlay = () => {
  const { currentVideoId, videoOpen } = usePlayer();
  if (!videoOpen || !currentVideoId) return null;
  return (
    <div className="video-frame absolute inset-1.5 z-50 overflow-hidden rounded-xl bg-black">
      <YouTubeVideo key={currentVideoId} videoId={currentVideoId} />
    </div>
  );
};
